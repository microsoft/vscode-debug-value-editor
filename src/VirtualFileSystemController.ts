import {
	FileSystemProvider,
	Uri,
	FileStat,
	FileType,
	FileChangeEvent,
	EventEmitter,
	workspace,
	FileChangeType,
} from "vscode";
import { Disposable, DisposableStore, IDisposable } from "./utils/disposables";

export function registerVirtualFs(options: {
	scheme: string,
	getInitialContent: (uri: Uri) => Promise<string | undefined>,
}): VirtualFileSystemProvider {
	const fs = new VirtualFileSystemProvider(options.scheme, options.getInitialContent);
	return fs;
}

export class VirtualFileSystemProvider extends Disposable implements FileSystemProvider {
	private fileChangedEmitter = new EventEmitter<FileChangeEvent[]>();
	public readonly onDidChangeFile = this.fileChangedEmitter.event;

	private readonly fileLoading = new Map<string, Promise<File>>();
	private readonly files = new Map<string, File>();

	constructor(
		public readonly scheme: string,
		public readonly getInitialContent: (uri: Uri) => Promise<string | undefined>,
	) {
		super();

		this._register(workspace.registerFileSystemProvider(scheme, this, {
			isCaseSensitive: true,
			isReadonly: false,
		}));
	}

	public getExistingFile(uri: Uri): File | undefined {
		return this.files.get(uri.toString());
	}

	private async getFile(uri: Uri): Promise<File> {
		const f = this.files.get(uri.toString());
		if (f) {
			return f;
		}

		let loader = this.fileLoading.get(uri.toString());
		if (!loader) {
			loader = (async () => {
				try {
					const initialContent = await this.getInitialContent(uri);
					if (initialContent === undefined) {
						throw new Error(`File ${uri} not found`);
					} else {
						const { file } = this.getOrCreateFile(uri);
						file.writeString(initialContent);
						this.files.set(uri.toString(), file);
						return file;
					}
				} finally {
					this.fileLoading.delete(uri.toString());
				}
			})();
			this.fileLoading.set(uri.toString(), loader);
		}
		return await loader;
	}

	public getOrCreateFile(uri: Uri): { file: File; didFileExist: boolean } {
		const key = uri.toString();

		const f = this.files.get(key);
		if (f) {
			return { file: f, didFileExist: true };
		}

		const d = new DisposableStore();

		const file = new File(uri, Uint8Array.from([]), () => {
			d.dispose();
			this.files.delete(key);
			this.fileChangedEmitter.fire([
				{ type: FileChangeType.Deleted, uri: file.uri }
			]);
		});

		d.add(file.onDidChangeFile(() =>
			this.fileChangedEmitter.fire([
				{ type: FileChangeType.Changed, uri: file.uri },
			])
		));
		this.files.set(key, file);
		return { file: file, didFileExist: false };
	}

	async readFile(uri: Uri): Promise<Uint8Array> {
		const file = await this.getFile(uri);
		return file.data;
	}

	async writeFile(
		uri: Uri,
		content: Uint8Array,
		options: { create: boolean; overwrite: boolean }
	): Promise<void> {
		const file = await this.getFile(uri);
		await file.write(content);
	}

	async stat(uri: Uri): Promise<FileStat> {
		const file = await this.getFile(uri);
		return {
			type: FileType.File,
			ctime: 0,
			mtime: 0,
			size: file.data.length,
		};
	}

	watch(
		uri: Uri,
		options: { recursive: boolean; excludes: string[] }
	): IDisposable {
		return new DisposableStore();
	}

	readDirectory(
		uri: Uri
	): [string, import("vscode").FileType][] | Thenable<[string, import("vscode").FileType][]> {
		throw new Error("Method not implemented.");
	}

	createDirectory(uri: Uri): void | Thenable<void> {
		throw new Error("Method not implemented.");
	}

	delete(uri: Uri, options: { recursive: boolean }): void | Thenable<void> {
		throw new Error("Method not implemented.");
	}

	rename(
		oldUri: Uri,
		newUri: Uri,
		options: { overwrite: boolean }
	): void | Thenable<void> {
		throw new Error("Method not implemented.");
	}
}


export class File {
	private readonly _fileChangedEmitter = new EventEmitter();
	public readonly onDidChangeFile = this._fileChangedEmitter.event;

	constructor(
		public readonly uri: Uri,
		public data: Uint8Array,
		public readonly deleteFile: () => void,
	) { }

	public write(data: Uint8Array): void {
		this.data = data;
		this._fileChangedEmitter.fire(undefined);
	}

	public writeString(str: string): void {
		this.write(Uint8Array.from(Buffer.from(str, "utf-8")));
	}

	public readString(): string {
		return Buffer.from(this.data).toString("utf-8");
	}
}
