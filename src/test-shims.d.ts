declare module 'node:test' {
  type TestFn = (name: string, fn: () => void | Promise<void>) => void;
  export const test: TestFn;
}

declare module 'node:assert/strict' {
  interface NodeAssert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  }
  const assert: NodeAssert;
  export = assert;
}
