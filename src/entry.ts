import { ExtensionContext } from "vscode";
import { hotReloadExportedItem } from "@hediet/node-reload";
import { enableHotReload } from "@hediet/node-reload/node";
import path = require("path");

enableHotReload({ entryModule: module, loggingFileRoot: path.join(__dirname, '..'), skipIfEnabled: true });

import { Extension } from "./extension";

export class Ext extends Extension { }

export function activate(context: ExtensionContext) {
	context.subscriptions.push(hotReloadExportedItem(Ext, Ext => new Ext(context)));
}
