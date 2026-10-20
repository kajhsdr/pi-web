import { useCallback, useEffect, useRef, useState } from "react";
import { writeFileContent } from "@/lib/file-write";
import type { FileEditorDraft, FileViewerContent } from "@/lib/file-viewer-state";

interface Options {
  filePath: string;
  sourceSessionId?: string | null;
  initialDraft?: FileEditorDraft;
  invalidateReads: () => void;
  onDraftChange: (draft: FileEditorDraft | undefined) => void;
}

export function useFileEditor({ filePath, sourceSessionId, initialDraft, invalidateReads, onDraftChange }: Options) {
  const [editing, setEditing] = useState(initialDraft);
  const editingRef = useRef(editing);
  const [editorKey, setEditorKey] = useState(0);
  const [, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  useEffect(() => {
    if (!editing) return;
    editing.listeners.add(refresh);
    // 保存可能在渲染与订阅之间已经完成，此处同步最新状态。
    refresh();
    return () => { editing.listeners.delete(refresh); };
  }, [editing, refresh]);

  const startEditing = useCallback((baseline: FileViewerContent) => {
    if (baseline.truncated || baseline.mtimeMs === undefined || editingRef.current) return;
    invalidateReads();
    const next: FileEditorDraft = {
      content: baseline.content,
      baseline: { ...baseline },
      saveState: "idle",
      saveError: null,
      listeners: new Set(),
    };
    editingRef.current = next;
    setEditing(next);
    onDraftChangeRef.current(next);
    setEditorKey((key) => key + 1);
  }, [invalidateReads]);

  const stopEditing = useCallback(() => {
    if (editingRef.current?.saveState === "saving") return;
    editingRef.current = undefined;
    setEditing(undefined);
    onDraftChangeRef.current(undefined);
  }, []);

  const handleDraftChange = useCallback((content: string) => {
    const draft = editingRef.current;
    if (!draft) return;
    const wasDirty = draft.content !== draft.baseline.content;
    draft.content = content;
    if (wasDirty !== (content !== draft.baseline.content)) {
      for (const listener of draft.listeners) listener();
    }
  }, []);

  const saveDraft = useCallback(async () => {
    const draft = editingRef.current;
    if (!draft || draft.saveState === "saving" || draft.content === draft.baseline.content) return;
    const content = draft.content;
    const expectedMtimeMs = draft.baseline.mtimeMs;
    if (expectedMtimeMs === undefined) return;
    draft.saveState = "saving";
    draft.saveError = null;
    for (const listener of draft.listeners) listener();
    try {
      const result = await writeFileContent({ filePath, content, expectedMtimeMs, sessionId: sourceSessionId });
      if (result.ok) {
        // 仅将本次提交文本设为基线，请求期间的新输入仍保持未保存状态。
        draft.baseline = { ...draft.baseline, content, size: result.size, mtimeMs: result.mtimeMs };
        draft.saveState = "saved";
      } else {
        draft.saveState = result.reason === "conflict" ? "conflict" : "error";
        draft.saveError = result.error;
      }
    } catch (error) {
      draft.saveState = "error";
      draft.saveError = String(error);
    }
    for (const listener of draft.listeners) listener();
  }, [filePath, sourceSessionId]);

  const replaceFromDisk = useCallback((baseline: FileViewerContent) => {
    const draft = editingRef.current;
    if (!draft || draft.saveState === "saving" || baseline.truncated || baseline.mtimeMs === undefined) return;
    draft.content = baseline.content;
    draft.baseline = { ...baseline };
    draft.saveState = "idle";
    draft.saveError = null;
    setEditorKey((key) => key + 1);
    for (const listener of draft.listeners) listener();
  }, []);

  return {
    editing,
    draft: editing?.content ?? null,
    dirty: Boolean(editing && editing.content !== editing.baseline.content),
    saveState: editing?.saveState ?? "idle",
    saveError: editing?.saveError ?? null,
    editorKey,
    startEditing,
    stopEditing,
    handleDraftChange,
    saveDraft,
    replaceFromDisk,
  };
}
