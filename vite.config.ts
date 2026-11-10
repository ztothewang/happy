import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  // One bundle loaded from disk by a desktop app; the 500 kB web hint doesn't apply.
  build: { outDir: "../../dist/renderer", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
