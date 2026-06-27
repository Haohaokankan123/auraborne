// Vite configuration for the Kart Racer game.
// This file tells Vite (our dev server and bundler) how to run and build the project.
// It is an ES module, so we use `export default` to hand the config object to Vite.

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// `defineConfig` is a helper from Vite. It does not change the config —
// it just gives editors type hints/autocomplete for the options below.
export default defineConfig({
  // RELATIVE base so the built bundle works at ANY URL path: served at the root
  // "/" (the Node/Render single-origin deploy + local preview) AND under a project
  // subpath like "/auraborne/" (GitHub Pages). Emitted asset URLs become
  // "./assets/..." which resolve against whatever path index.html loads from.
  base: './',

  // Plugins extend what Vite can do.
  // The Tailwind v4 Vite plugin scans our CSS/HTML and generates utility classes.
  plugins: [tailwindcss()],

  server: {
    // The local dev server runs at http://localhost:5173
    port: 5173,

    // The proxy is for LATER multiplayer work. It forwards any request that
    // starts with "/socket.io" to the game server on port 3001.
    // `ws: true` lets WebSocket connections (used by socket.io) pass through too.
    // This is harmless right now because nothing connects to /socket.io yet.
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },

  build: {
    // The Three.js vendor chunk alone is ~530KB (the library is just big).
    // Once it is split out into its own cacheable file, that size is expected
    // and unavoidable, so we raise the warning threshold past it to keep the
    // build log clean. Our own app chunk stays well under this limit.
    chunkSizeWarningLimit: 600,

    // Split the heavy Three.js library into its own "vendor" chunk.
    // WHY: Three.js is ~600KB and changes rarely. Our own game code changes
    // often. Keeping them in SEPARATE files means browsers can cache the big
    // Three.js chunk once and only re-download the small app chunk when we
    // ship a game update. It also silences the >500KB single-chunk warning.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // `id` is the absolute path of each module Rollup processes.
          // Anything coming from node_modules/three goes into a chunk we name
          // "three"; everything else stays in the default app chunk.
          if (id.includes('node_modules/three')) {
            return 'three';
          }
        },
      },
    },
  },
});
