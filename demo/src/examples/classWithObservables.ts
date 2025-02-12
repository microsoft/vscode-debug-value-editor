import { autorun, derived, observableValue, transaction } from "../../../../vscode/src/vs/base/common/observable";

class Contact {
    public readonly firstName = observableValue(this, '');
    public readonly lastName = observableValue(this, '');
    public readonly fullName = derived(this, reader => {
        return this.firstName.read(reader) + ' ' + this.lastName.read(reader);
    });

    constructor(
        initialFirstName: string,
        initialLastName: string,
    ) {
        this.firstName.set(initialFirstName, undefined);
        this.lastName.set(initialLastName, undefined);
    }
}

const contacts = [
    new Contact('Jane', 'Doe'),
    new Contact('Max', 'Mustermann'),
];

autorun(reader => {
    //console.log('contacts changed');
    for (const c of contacts) {
        c.fullName.read(reader);
    }
});

let i = 0;
setInterval(() => {
    transaction(tx => {
        contacts[0].firstName.set('John ' + i++, tx);
    });
}, 100);
