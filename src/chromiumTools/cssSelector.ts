import { window } from "vscode";
import { DebugSessionService } from "../debugService/DebugSessionService";
import { IDebugSupport } from "../debugService/IDebugSupport";
import { observableFromEvent } from "../utils/observables/observable";
import { Disposable } from "../utils/disposables";
import { mapObservableArrayCached } from "../utils/observables/observableInternal/utils";
import { JsDebugSupport } from "../debugService/JsDebugSupport";

export class ChromiumTools extends Disposable {
    private readonly _openEditors = observableFromEvent(window.onDidChangeVisibleTextEditors, e => window.visibleTextEditors);

    constructor(
        private readonly _debugSessionService: DebugSessionService,
        private readonly _debugSupport: IDebugSupport,

    ) {
        super();

        const support = _debugSupport as JsDebugSupport;


        const states = mapObservableArrayCached(this, this._debugSessionService.debugSessions, async (session, store) => {
            const s = support.getDebugSession(session);
            if (!s) { return; }

            await new Promise(r => setTimeout(r, 3000));
            const c = await s.getCdpClient();
            if (!c) {
                return;
            }
            c.subscribe('Overlay', 'inspectNodeRequested', e => {
                console.log(e);
            });
            c.subscribe('Overlay', 'nodeHighlightRequested', e => {
                console.log(e);
            });

            //console.log(await c.request('Overlay', 'setInspectMode', { mode: 'searchForNode', highlightConfig: { showInfo: true } }));

            /*
            console.log(await c.request('DOM', 'enable', {}));
            console.log(await c.request('Overlay', 'enable', {}));

            // DOM.querySelector

            const result = await c.request('DOM', 'getDocument', {});
            const rootId = result.root.nodeId;
            const x = await c.request('DOM', 'querySelector', { nodeId: rootId, selector: 'button' });
            // hightlight
            await c.request('Overlay', 'highlightNode', { highlightConfig: { showInfo: true }, nodeId: x.nodeId });
*/


            console.log(await c.request('Runtime', 'enable', {}));
            // evaluate inspect($('button'))

            console.log(await c.request('Runtime', 'evaluate', { expression: 'inspect($("button"))', includeCommandLineAPI: true }));
            globalThis.c = c;

        }).recomputeInitiallyAndOnChange(this._store);
    }
}
