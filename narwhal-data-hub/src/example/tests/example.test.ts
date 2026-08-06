import { describe, it, expect } from "vitest";
import { hello } from "../index.js";

describe("example package", () => {
  it("greets through the entry point", () => {
    expect(hello("narwhal")).toBe("hello, narwhal");
  });
});
