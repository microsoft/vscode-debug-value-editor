
// import path = require("path");
// import hot = require("@hediet/node-reload/node");
// hot.enableHotReload({ entryModule: module, loggingFileRoot: path.join(__dirname, '..'), skipIfEnabled: true });

import { ExtensionContext } from "vscode";
import { hotReloadExportedItem } from "@hediet/node-reload";
import { Extension } from "./extension";

export class Ext extends Extension { }

export function activate(context: ExtensionContext) {
	context.subscriptions.push(hotReloadExportedItem(Ext, Ext => new Ext(context)));
}
