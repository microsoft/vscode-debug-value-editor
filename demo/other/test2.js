export async function foo() {
    try {
        null();
    } catch (e) {
    }

    await new Promise((res, rej) => {
        rej(new Error());
    });
}