/**
 * config.ts — loads and exposes config.json.
 *
 * Reads the plugin's config.json (self-documenting, see §3 of the spec).
 * Exposes model capabilities and tuning knobs to the tool.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MaxBytes {
	image: number;
}

export interface ModelConfig {
	input: string[];
	maxBytes?: MaxBytes;
}

/** Gate tuning (defaults + per-plugin override). */
export interface GateConfig {
	maxDim?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface GateOptions {
	/** Max width or height after gating (px). */
	maxDim: number;
	/** Base64 budget (bytes) for the serialized image. */
	maxBytes: number;
	/** Starting JPEG quality (1-100) for derived rasters. */
	jpegQuality: number;
}

export interface PluginConfig {
	models: Record<string, ModelConfig>;
	defaults: {
		input: string[];
		maxBytes: MaxBytes;
		executionMode: "parallel" | "sequential";
		ffmpegTimeoutMs: number;
		pdf?: {
			defaultDpi?: number;
			maxPagesPerCall?: number;
		};
		imageGate?: GateConfig;
	};
}

/** Gate defaults: 2000px longest side, 4.5MB base64 budget, JPEG quality 80. */
export const GATE_DEFAULTS: GateOptions = {
	maxDim: 2000,
	maxBytes: 4718592,
	jpegQuality: 80,
};

let cached: PluginConfig | undefined;

/** User-owned config location (survives pi updates). */
export function userConfigPath(): string {
	return join(homedir(), ".pi", "agent", "extensions", "pi-extendedread", "config.json");
}

export function loadConfig(pluginDir: string): PluginConfig {
	if (cached) return cached;

	const userPath = userConfigPath();

	// First run: generate config from the plugin's default.
	if (!existsSync(userPath)) {
		const defaultPath = join(pluginDir, "config.json");
		if (existsSync(defaultPath)) {
			mkdirSync(join(homedir(), ".pi", "agent", "extensions", "pi-extendedread"), { recursive: true });
			writeFileSync(userPath, readFileSync(defaultPath, "utf-8"));
		}
	}

	if (!existsSync(userPath)) {
		cached = JSON.parse(readFileSync(join(pluginDir, "config.json"), "utf-8")) as PluginConfig;
		return cached;
	}

	const raw = readFileSync(userPath, "utf-8");
	cached = JSON.parse(raw) as PluginConfig;
	return cached;
}

/** Resolve effective config for a given model ID. */
export function resolveModelConfig(config: PluginConfig, modelId: string): { input: string[]; maxBytes: MaxBytes } {
	const model = config.models[modelId];
	return {
		input: model?.input ?? config.defaults.input,
		maxBytes: {
			image: model?.maxBytes?.image ?? config.defaults.maxBytes.image,
		},
	};
}

/** Resolve the effective gate options from config (defaults fill in). */
export function resolveGateOptions(config: PluginConfig): GateOptions {
	const g = config.defaults.imageGate ?? {};
	return {
		maxDim: g.maxDim ?? GATE_DEFAULTS.maxDim,
		maxBytes: g.maxBytes ?? GATE_DEFAULTS.maxBytes,
		jpegQuality: g.jpegQuality ?? GATE_DEFAULTS.jpegQuality,
	};
}

export function ffmpegTimeout(config: PluginConfig): number {
	return config.defaults.ffmpegTimeoutMs;
}

export function executionMode(config: PluginConfig): "parallel" | "sequential" {
	return config.defaults.executionMode;
}
