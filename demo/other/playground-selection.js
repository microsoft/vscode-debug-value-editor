class Playground {
	_len = 0;
	_str = "";

	get len() {
		return {
			$fileExtension: "jsonUi.w", // Make sure you have a custom editor for this file extension installed!
			value: { len: this._len },
			schema: {
				title: "data2",
				type: "object",
				properties: {
					len: {
						type: "number",
						format: "range",
						default: 5,
						minimum: 0,
						maximum: 20,
						step: 1,
					},
				},
			},
		};
	}

	set len(value) {
		this._len = value.value.len;

		if (this._len > this._str.length) {
			this._str += "a".repeat(this._len - this._str.length);
		} else {
			this._str = this._str.slice(0, this._len);
		}
	}

	get str() {
		return this._str;
	}
	set str(value) {
		this._str = value;
		this._len = value.length;
	}
}

const t = new Playground();

t.len, t.str; // editable

t.len; // editable
t.str; // editable

debugger;
