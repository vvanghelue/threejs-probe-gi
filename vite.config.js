import { defineConfig } from 'vite';

// relative base so the build works both locally and under https://<user>.github.io/<repo>/
export default defineConfig({
  base: './',
});
