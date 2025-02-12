import { foo } from './test2.js';
console.log("Hello from test.js");

foo();


try {
    undefined.foo();
} catch (e) {
    console.log('caught');
}

