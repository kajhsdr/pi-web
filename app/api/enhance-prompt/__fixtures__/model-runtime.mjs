// Stands in for lib/model-runtime in the enhance-prompt route test: the real
// one builds (or reuses) a runtime by loading every extension, which a unit
// test must not do. The test assigns `globalThis.__piWebEnhanceRuntime`.
export async function getModelRuntimeWithExtensions() {
	return globalThis.__piWebEnhanceRuntime;
}
