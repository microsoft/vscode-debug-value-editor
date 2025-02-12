import { autorun, derived, observableValue } from "../observableInternal/index";

const v = observableValue('test', 0);

const d = derived(reader => Math.floor(v.read(reader) / 2));

autorun(reader => {
    const val = d.read(reader);
    console.log('derived', val);
});

setInterval(() => {
    v.set(v.get() + 1, undefined);
    //console.log('test', v.get());
}, 200);
