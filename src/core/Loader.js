// src/core/Loader.js
//
// AssetLoader: a small wrapper around three's GLTFLoader that also wires up
// DRACOLoader (mesh compression) and KTX2Loader (compressed GPU textures).
//
// Why this exists:
//   Loading 3D models and textures the raw way means repeating the same setup
//   (decoder paths, caching, error handling) everywhere. This class does that
//   setup once so the rest of the game can just call loadModel(url) and get a
//   ready-to-use scene back. It is infrastructure for later milestones — it is
//   fine if nothing imports it yet in M1.
//
// What each piece is:
//   - GLTFLoader  : loads .gltf / .glb 3D model files (the standard 3D format).
//   - DRACOLoader  : decompresses Draco-compressed geometry inside a glTF so
//                    big models download as small files.
//   - KTX2Loader  : loads .ktx2 textures, which are compressed in a format the
//                    GPU can read directly (smaller memory + faster upload).
//
// Note: three core is imported as a namespace; addon loaders come from the
// 'three/addons/' path, which resolves correctly in three 0.184 under Vite.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

// Where the Draco decoder files (.js/.wasm) are hosted. Using Google's CDN
// means we do not have to copy decoder binaries into our own project.
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/v1/decoders/';

// Where the KTX2 (Basis) transcoder files live. This 'three/addons/' path maps
// to three's bundled examples/jsm/libs/basis/ folder, which Vite serves for us.
const KTX2_TRANSCODER_PATH = 'three/addons/libs/basis/';

// A 1x1 white PNG, used to stand in for missing external model textures so a
// model with an unbundled texture still loads (see the LoadingManager shim).
const WHITE_PIXEL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4//8/AAX+Av7czFnnAAAAAElFTkSuQmCC';

export class AssetLoader {
	constructor() {
		// --- Loading manager with a missing-texture shim --------------------
		// The Kenney "Car Kit" GLBs ship the geometry embedded but reference their
		// shared palette as an EXTERNAL image ("Textures/colormap.png"), which is
		// not bundled here. A missing texture makes GLTFLoader reject the whole
		// load — so the model would never appear. Redirect any such external
		// Kenney texture request to a 1x1 white pixel: the model then loads
		// untextured (white), and the Kart tints it to the per-character color
		// anyway. Only paths under a "Textures/" folder are rewritten, so the
		// .glb itself (and any real texture we DO ship) is untouched.
		// ponytail: white-pixel shim, drop it if the real colormap.png is bundled.
		this.manager = new THREE.LoadingManager();
		this.manager.setURLModifier((url) =>
			/Textures\/[^/]+\.(png|jpe?g|webp)$/i.test(url) ? WHITE_PIXEL : url
		);

		// --- Draco geometry decompression ---
		this.dracoLoader = new DRACOLoader();
		this.dracoLoader.setDecoderPath(DRACO_DECODER_PATH);

		// --- KTX2 compressed-texture transcoding ---
		this.ktx2Loader = new KTX2Loader();
		this.ktx2Loader.setTranscoderPath(KTX2_TRANSCODER_PATH);

		// --- Main glTF model loader, wired to use the two helpers above ---
		this.gltfLoader = new GLTFLoader(this.manager);
		this.gltfLoader.setDRACOLoader(this.dracoLoader);
		this.gltfLoader.setKTX2Loader(this.ktx2Loader);

		// Plain texture loader for standalone image files (png/jpg/etc).
		this.textureLoader = new THREE.TextureLoader();

		// Cache of already-loaded models, keyed by the url string. This stops us
		// from downloading and parsing the same model twice.
		this.modelCache = new Map();

		// Tracks whether setRenderer() has been called. KTX2 textures cannot be
		// transcoded until the loader knows what the GPU supports, so we warn if
		// someone tries to load before doing that setup.
		this.rendererReady = false;
	}

	// Tell the KTX2 loader which renderer (GPU) it is loading textures for.
	// This MUST be called once (after the WebGLRenderer is created) before any
	// .ktx2 texture is loaded — otherwise KTX2Loader throws. Models without
	// KTX2 textures still load fine without this, so it is optional in that case.
	setRenderer(renderer) {
		if (!renderer) {
			throw new Error('AssetLoader.setRenderer: a THREE.WebGLRenderer is required.');
		}
		this.ktx2Loader.detectSupport(renderer);
		this.rendererReady = true;
	}

	// Load a glTF/glb model from a url and resolve with its scene (a THREE.Group
	// you can add straight into your scene graph). Results are cached by url.
	//
	// Returns: Promise<THREE.Group> (the gltf.scene).
	// Rejects: with a clear Error if the file fails to load or parse.
	async loadModel(url) {
		if (!url) {
			throw new Error('AssetLoader.loadModel: a url string is required.');
		}

		// Return the cached scene if we have already loaded this url.
		if (this.modelCache.has(url)) {
			return this.modelCache.get(url);
		}

		// GLTFLoader.load uses callbacks, so we wrap it in a Promise to use await.
		const gltf = await new Promise((resolve, reject) => {
			this.gltfLoader.load(
				url,
				// onLoad: success — hand back the whole gltf object.
				(loadedGltf) => resolve(loadedGltf),
				// onProgress: not used here, but the slot must exist.
				undefined,
				// onError: turn the raw error into a clear, readable message.
				(error) => {
					const reason = error && error.message ? error.message : String(error);
					reject(new Error(`AssetLoader.loadModel: failed to load model "${url}" — ${reason}`));
				}
			);
		});

		const scene = gltf.scene;
		this.modelCache.set(url, scene);
		return scene;
	}

	// Load a standalone image texture (png/jpg/etc) from a url.
	//
	// Returns: Promise<THREE.Texture>.
	// Rejects: with a clear Error if the image fails to load.
	async loadTexture(url) {
		if (!url) {
			throw new Error('AssetLoader.loadTexture: a url string is required.');
		}

		return new Promise((resolve, reject) => {
			this.textureLoader.load(
				url,
				// onLoad: success.
				(texture) => resolve(texture),
				// onProgress: not used.
				undefined,
				// onError: readable failure message.
				(error) => {
					const reason = error && error.message ? error.message : String(error);
					reject(new Error(`AssetLoader.loadTexture: failed to load texture "${url}" — ${reason}`));
				}
			);
		});
	}

	// Free the GPU/worker resources held by the decoder loaders. Call this when
	// the AssetLoader is no longer needed (e.g. tearing down a scene). Optional
	// but tidy — DRACOLoader/KTX2Loader each spin up a Web Worker pool.
	dispose() {
		this.dracoLoader.dispose();
		this.ktx2Loader.dispose();
		this.modelCache.clear();
	}
}
