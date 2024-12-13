
class Playground {
    _original = '';
    _reversed = '';
    get original() { return this._original; }
    set original(val) {
        this._original = val;
        this._reversed = [...val].reverse().join('');
        this._updatePromise();
    }
    get reversed() { return this._reversed; }
    set reversed(val) {
        this._reversed = val;
        this._original = [...val].reverse().join('');
        this._updatePromise();
    }

    constructor() {
        this._updatePromise();
    }

    combinedPromise;

    _updatePromise() {
        this.combinedPromise = new Promise((resolve, reject) => {
            setTimeout(() => {
                resolve(this._original + " ## " +  this.reversed);
            }, 1000);
        });
    }
}

const t = new Playground();

t.original, t.reversed, t.combinedPromise; // editable

globalThis.t = t;

setInterval(() => {}, 1000);


function foo() {
    globalThis.$$debugValueEditor_properties = [
        "t.original",
        "t.reversed",
        "t.combinedPromise",
    ];
}

function bar() {
    globalThis.$$debugValueEditor_properties = [
        "t.original",
    ];
}

globalThis.foo = foo;
globalThis.bar = bar;

foo();

globalThis.$$debugValueEditor_run = function(args) {
    console.log('run', args);
};

console.log('init');
