
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
