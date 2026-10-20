export type FileViewerDisplayMode = "source" | "preview" | "diff" | "records";

export interface FileViewerContent {
  content: string;
  language: string;
  size: number;
  nextOffset: number;
  truncated: boolean;
  mtimeMs?: number;
}

// 标签与对应 viewer 共享页面内的编辑状态。
// viewer 卸载期间，保存结果仍更新同一份状态。
export interface FileEditorDraft {
  content: string;
  baseline: FileViewerContent;
  saveState: "idle" | "saving" | "saved" | "conflict" | "error";
  saveError: string | null;
  listeners: Set<() => void>;
}

export function hasUnsavedFileDraft(state?: FileViewerState): boolean {
  const draft = state?.editing;
  return Boolean(draft && (draft.content !== draft.baseline.content || draft.saveState === "saving"));
}

export interface FileViewerState {
  editing?: FileEditorDraft;
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}
