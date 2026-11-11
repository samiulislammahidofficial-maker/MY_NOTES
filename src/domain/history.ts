import type { InkStroke, Layer, Page, TextBox } from './types';

/** Mutable target a command operates on. */
export interface StrokeTarget {
  addStroke(s: InkStroke): void;
  removeStroke(pageId: string, id: string): void;
  /** Atomically remove `remove` and add `add` (one durable transaction). */
  replace(pageId: string, remove: InkStroke[], add: InkStroke[]): void;
  addText?(tb: TextBox): void;
  removeText?(pageId: string, id: string): void;
  insertPage?(notebookId: string, page: Page, layer: Layer, afterPageId?: string): void;
  removeAddedPage?(notebookId: string, pageId: string, fallbackPageId?: string): void;
}

export interface Command {
  readonly label: string;
  apply(t: StrokeTarget): void;
  inverse(t: StrokeTarget): void;
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

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}
