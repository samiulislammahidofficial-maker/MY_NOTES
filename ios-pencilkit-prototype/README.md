# PencilKit iPad Hardware Prototype

A standalone, minimal native iPad target built with **SwiftUI** and Apple's **PencilKit (`PKCanvasView`)** to benchmark hardware Apple Pencil tap capture against Safari/WebKit.

## Purpose

When testing rapid, separate physical pen taps on iPad Safari, WebKit's gesture recognizers and touch-action event pipeline can occasionally swallow or coalesce ultra-short contacts (<15ms).

This native prototype connects directly to iOS's low-level Apple Pencil hardware pipeline (`PKCanvasView.drawingPolicy = .pencilOnly`) with zero WebKit overhead.

---

## Features

- **PencilKit Canvas**: Uses native `PKCanvasView` configured with `PKInkingTool(.pen, color: .label, width: 3)`.
- **Live Committed Strokes Counter**: Listens directly to `PKCanvasViewDelegate.canvasViewDrawingDidChange(_:)` to count exact committed `PKDrawing.strokes.count`.
- **Target Indicator**: Configured for 40 marks test.
- **Clear Canvas Button**: Clears the canvas and resets the committed stroke counter.
- **Pencil Only Policy**: Rejects finger contacts so palm resting never pollutes test results.

---

## Xcode Run Steps (Physical iPad)

1. **Open on Mac with Xcode**:
   - Transfer or clone this directory (`ios-pencilkit-prototype`) to a Mac running macOS with Xcode 14+ or 15+.
   - You can open the folder directly in Xcode (as a Swift Package) or create a new iOS App project:
     - Open Xcode > **File** > **New** > **Project** > **iOS App** (Interface: **SwiftUI**, Language: **Swift**).
     - Product Name: `PencilKitBenchmark`.
     - Replace `ContentView.swift` and `@main App` with [`PencilKitBenchmarkApp.swift`](file:///e:/My_Notes/ios-pencilkit-prototype/PencilKitBenchmarkApp.swift).
2. **Configure Signing**:
   - In Xcode project settings, under **Signing & Capabilities**, select your Apple ID / Developer Team.
3. **Connect Physical iPad**:
   - Connect the iPad (the same iPad and Apple Pencil where Safari missed rapid taps).
   - In the target destination dropdown in Xcode, select your connected iPad.
4. **Build & Run**:
   - Press **Cmd + R** (or click the Run button) to launch on the iPad.
5. **Execute the Rapid Tap Test**:
   - Make **40 rapid, separate pen taps** across the screen, lifting the pencil completely between taps.
   - Observe the committed stroke counter:
     - Verify if 40 physical pen taps produce **40 visible marks and 40 committed strokes**.
     - If PencilKit achieves 40/40 while Safari achieves 20–26/40, the bottleneck is conclusively isolated to WebKit/Safari event dispatching.
