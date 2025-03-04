import { autorun, derived, observableValue } from "../observableInternal/index";

const v = observableValue('test', 0);

const d = derived(reader => Math.floor(v.read(reader) / 2));

autorun(reader => {
    const vVal = v.read(reader);
    if (Math.floor(vVal / 5) % 2 === 0) {
        const dVal = d.read(reader);
        console.log('vVal', vVal, 'dVal', dVal);
    } else {
        console.log('vVal', vVal);
    }
});

setInterval(() => {
    v.set(v.get() + 1, undefined);
    //console.log('test', v.get());
}, 200);
