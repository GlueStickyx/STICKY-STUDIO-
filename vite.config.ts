import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Relative base so the build works at any path (GitHub Pages project site, local file server).
export default defineConfig({ base: './', plugins: [react()], build: { target: 'es2021' } });
