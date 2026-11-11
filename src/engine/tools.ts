import type { Template } from '../domain/types';

export type ToolKind = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape' | 'hand' | 'laser' | 'text';
export type Nib = 'ballpoint' | 'fountain' | 'brush';
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type ShapeKind = 'line' | 'rect' | 'ellipse';

export interface ToolSettings {
  kind: ToolKind;
  nib: Nib;
  strokeStyle: StrokeStyle;
  /** pen colour + width in document points */
  color: string;
  rainbow: boolean;
  width: number;
  opacity: number;
  hlColor: string;
  hlWidth: number;
  hlOpacity: number;
  eraserMode: 'stroke' | 'pixel';
  eraserRadius: number;
  shape: ShapeKind;
  scribbleErase: boolean;
  shapeSnap: boolean;
  rulerVisible: boolean;
  rulerUnits?: 'metric' | 'imperial';
  /** 0..1 */
  stabilizer: number;
  penOnly: boolean;
  fingerDrawing: boolean;
  constantPressure: number;
}

export interface LayerInfo {
  id: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
}

export interface SelectionInfo {
  count: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface PaperSpec {
  color: string;
  template: Template;
}
