import type { ImageBox, InkStroke, Layer, Page, TextBox } from './types';

/** Mutable target a command operates on. */
export interface StrokeTarget {
  addStroke(s: InkStroke): void;
  removeStroke(pageId: string, id: string): void;
  /** Atomically remove `remove` and add `add` (one durable transaction). */
  replace(pageId: string, remove: InkStroke[], add: InkStroke[]): void;
  addText?(tb: TextBox): void;
  removeText?(pageId: string, id: string): void;
  addImage?(img: ImageBox): void;
  removeImage?(pageId: string, id: string): void;
  insertPage?(notebookId: string, page: Page, layer: Layer, afterPageId?: string): void;
  removeAddedPage?(notebookId: string, pageId: string, fallbackPageId?: string): void;
}

export type SerializedStroke = Omit<InkStroke, 'samples'> & { samples: number[] };

export type SerializedCommand =
  | { kind: 'add-stroke'; stroke: SerializedStroke }
  | { kind: 'replace'; label: string; pageId: string; remove: SerializedStroke[]; add: SerializedStroke[] }
  | { kind: 'convert-ink'; pageId: string; sourceStrokes: SerializedStroke[]; textBox: TextBox; replaceInk: boolean }
  | { kind: 'update-text'; pageId: string; prev: TextBox | null; next: TextBox | null }
  | { kind: 'update-image'; pageId: string; prev: ImageBox | null; next: ImageBox | null }
  | { kind: 'add-page'; notebookId: string; page: Page; layer: Layer; afterPageId?: string };

function serializeStroke(s: InkStroke): SerializedStroke {
  return { ...s, samples: Array.from(s.samples) };
}

function deserializeStroke(s: SerializedStroke): InkStroke {
  return { ...s, samples: new Float32Array(s.samples) };
}

export interface Command {
  readonly label: string;
  apply(t: StrokeTarget): void;
  inverse(t: StrokeTarget): void;
  serialize?(): SerializedCommand;
}

export class AddStrokeCommand implements Command {
  readonly label = 'Add stroke';
  constructor(private stroke: InkStroke) {}
  apply(t: StrokeTarget) {
    t.addStroke(this.stroke);
  }
  inverse(t: StrokeTarget) {
    t.removeStroke(this.stroke.pageId, this.stroke.id);
  }
  serialize(): SerializedCommand {
    return { kind: 'add-stroke', stroke: serializeStroke(this.stroke) };
  }
}

/** Generic edit: erase, move, resize, delete, duplicate, paste all reduce to this. */
export class ReplaceCommand implements Command {
  constructor(readonly label: string, private pageId: string, private remove: InkStroke[], private add: InkStroke[]) {}
  apply(t: StrokeTarget) {
    t.replace(this.pageId, this.remove, this.add);
  }
  inverse(t: StrokeTarget) {
    t.replace(this.pageId, this.add, this.remove);
  }
  serialize(): SerializedCommand {
    return {
      kind: 'replace',
      label: this.label,
      pageId: this.pageId,
      remove: this.remove.map(serializeStroke),
      add: this.add.map(serializeStroke),
    };
  }
}

export class ConvertInkToTextCommand implements Command {
  readonly label = 'Convert ink to text';
  constructor(private pageId: string, private sourceStrokes: InkStroke[], private textBox: TextBox, private replaceInk: boolean) {}
  apply(t: StrokeTarget) {
    if (this.replaceInk && this.sourceStrokes.length) t.replace(this.pageId, this.sourceStrokes, []);
    t.addText?.(this.textBox);
  }
  inverse(t: StrokeTarget) {
    t.removeText?.(this.pageId, this.textBox.id);
    if (this.replaceInk && this.sourceStrokes.length) t.replace(this.pageId, [], this.sourceStrokes);
  }
  serialize(): SerializedCommand {
    return {
      kind: 'convert-ink',
      pageId: this.pageId,
      sourceStrokes: this.sourceStrokes.map(serializeStroke),
      textBox: this.textBox,
      replaceInk: this.replaceInk,
    };
  }
}

export class UpdateTextBoxCommand implements Command {
  readonly label = 'Edit text';
  constructor(private pageId: string, private prev: TextBox | null, private next: TextBox | null) {}
  apply(t: StrokeTarget) {
    if (this.prev) t.removeText?.(this.pageId, this.prev.id);
    if (this.next) t.addText?.(this.next);
  }
  inverse(t: StrokeTarget) {
    if (this.next) t.removeText?.(this.pageId, this.next.id);
    if (this.prev) t.addText?.(this.prev);
  }
  serialize(): SerializedCommand {
    return { kind: 'update-text', pageId: this.pageId, prev: this.prev, next: this.next };
  }
}

export class UpdateImageBoxCommand implements Command {
  readonly label = 'Edit image';
  constructor(private pageId: string, private prev: ImageBox | null, private next: ImageBox | null) {}
  apply(t: StrokeTarget) {
    if (this.prev) t.removeImage?.(this.pageId, this.prev.id);
    if (this.next) t.addImage?.(this.next);
  }
  inverse(t: StrokeTarget) {
    if (this.next) t.removeImage?.(this.pageId, this.next.id);
    if (this.prev) t.addImage?.(this.prev);
  }
  serialize(): SerializedCommand {
    return { kind: 'update-image', pageId: this.pageId, prev: this.prev, next: this.next };
  }
}

export class AddPageCommand implements Command {
  readonly label = 'Add page';
  constructor(
    private notebookId: string,
    private page: Page,
    private layer: Layer,
    private afterPageId?: string,
  ) {}
  apply(t: StrokeTarget) {
    t.insertPage?.(this.notebookId, this.page, this.layer, this.afterPageId);
  }
  inverse(t: StrokeTarget) {
    t.removeAddedPage?.(this.notebookId, this.page.id, this.afterPageId);
  }
  serialize(): SerializedCommand {
    return {
      kind: 'add-page',
      notebookId: this.notebookId,
      page: this.page,
      layer: this.layer,
      afterPageId: this.afterPageId,
    };
  }
}

export function deserializeCommand(raw: SerializedCommand): Command | null {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.kind) {
    case 'add-stroke':
      return new AddStrokeCommand(deserializeStroke(raw.stroke));
    case 'replace':
      return new ReplaceCommand(raw.label, raw.pageId, raw.remove.map(deserializeStroke), raw.add.map(deserializeStroke));
    case 'convert-ink':
      return new ConvertInkToTextCommand(raw.pageId, raw.sourceStrokes.map(deserializeStroke), raw.textBox, raw.replaceInk);
    case 'update-text':
      return new UpdateTextBoxCommand(raw.pageId, raw.prev, raw.next);
    case 'update-image':
      return new UpdateImageBoxCommand(raw.pageId, raw.prev, raw.next);
    case 'add-page':
      return new AddPageCommand(raw.notebookId, raw.page, raw.layer, raw.afterPageId);
    default:
      return null;
  }
}

export interface SerializedHistorySnapshot {
  undo: SerializedCommand[];
  redo: SerializedCommand[];
}

/** Per-notebook undo/redo. One gesture = one command. */
export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private seen = new Set<string>();

  constructor(private max = 200) {}

  /** Execute a command. Ignores a duplicate completion keyed by `key`. */
  run(cmd: Command, t: StrokeTarget, key?: string): boolean {
    if (key) {
      if (this.seen.has(key)) return false;
      this.seen.add(key);
    }
    cmd.apply(t);
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.max) this.undoStack.shift();
    this.redoStack = [];
    return true;
  }

  undo(t: StrokeTarget): Command | null {
    const c = this.undoStack.pop();
    if (!c) return null;
    c.inverse(t);
    this.redoStack.push(c);
    return c;
  }

  redo(t: StrokeTarget): Command | null {
    const c = this.redoStack.pop();
    if (!c) return null;
    c.apply(t);
    this.undoStack.push(c);
    return c;
  }

  toJSON(maxPersist = 30): SerializedHistorySnapshot {
    const u = this.undoStack.slice(-maxPersist).map((c) => c.serialize?.()).filter((x): x is SerializedCommand => !!x);
    const r = this.redoStack.slice(-maxPersist).map((c) => c.serialize?.()).filter((x): x is SerializedCommand => !!x);
    return { undo: u, redo: r };
  }

  loadFromJSON(snap: SerializedHistorySnapshot | null | undefined) {
    if (!snap || typeof snap !== 'object') return;
    if (Array.isArray(snap.undo)) {
      this.undoStack = snap.undo.map(deserializeCommand).filter((c): c is Command => !!c);
    }
    if (Array.isArray(snap.redo)) {
      this.redoStack = snap.redo.map(deserializeCommand).filter((c): c is Command => !!c);
    }
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}
