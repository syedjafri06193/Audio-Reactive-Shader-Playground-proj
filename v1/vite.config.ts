import { defineConfig } from "vite";

export default defineConfig({
  // `?raw` on the prelude is what lets preludeLineCount() count the real
  // file rather than a hard-coded number, so adding a uniform can never
  // silently shift every error message.
  assetsInclude: ["**/*.glsl"],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    // Web MIDI and getUserMedia both require a secure context. localhost
    // counts as one, which is why the dev server is usable without certs.
    host: "localhost",
  },
});
