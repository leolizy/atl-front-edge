import { greet } from "./lib/impl.js";

export function hello(name: string): string {
  return greet(name);
}
