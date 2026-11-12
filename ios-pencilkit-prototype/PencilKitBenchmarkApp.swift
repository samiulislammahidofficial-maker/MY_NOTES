import SwiftUI
import PencilKit

/// Minimal native iPad PencilKit prototype.
/// Designed to benchmark raw hardware Apple Pencil tap capture against Safari/WebKit.
@main
struct PencilKitBenchmarkApp: App {
    var body: some Scene {
        WindowGroup {
            BenchmarkContentView()
        }
    }
}

struct BenchmarkContentView: View {
    @State private var canvasView = PKCanvasView()
    @State private var committedStrokesCount: Int = 0
    @State private var lastStrokeTimestamp: Date? = nil
    @State private var testTargetCount: Int = 40

    var body: some View {
        ZStack {
            Color(UIColor.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                // Header Control Bar
                HStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("PencilKit Native Benchmark")
                            .font(.headline)
                            .foregroundColor(.primary)
                        Text("Apple Pencil Direct Hardware Probe (Bypasses WebKit)")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    // Committed Strokes Counter Card
                    HStack(spacing: 12) {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("COMMITTED STROKES")
                                .font(.caption2)
                                .fontWeight(.semibold)
                                .foregroundColor(.secondary)
                            Text("\(committedStrokesCount)")
                                .font(.system(size: 32, weight: .bold, design: .rounded))
                                .foregroundColor(committedStrokesCount >= testTargetCount ? .green : .blue)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color(UIColor.secondarySystemBackground))
                    .cornerRadius(10)

                    // Target indicator
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("TARGET")
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                        Text("\(testTargetCount)")
                            .font(.system(size: 20, weight: .semibold, design: .rounded))
                            .foregroundColor(.secondary)
                    }

                    // Clear Canvas Button
                    Button(action: clearCanvas) {
                        Label("Clear Canvas", systemImage: "trash")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.red)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Color(UIColor.secondarySystemBackground))
                            .cornerRadius(8)
                    }
                }
                .padding()
                .background(Color(UIColor.secondarySystemBackground).opacity(0.5))

                // Test Instructions Bar
                HStack {
                    Image(systemName: "pencil.tip.crop.circle")
                        .foregroundColor(.blue)
                    Text("Test instructions: Tap the Apple Pencil rapidly **40 times** across the canvas below, lifting completely between taps.")
                        .font(.footnote)
                        .foregroundColor(.primary)
                    Spacer()
                    if committedStrokesCount == testTargetCount {
                        Text("✅ 40 / 40 PERFECT SCORE")
                            .font(.footnote)
                            .fontWeight(.bold)
                            .foregroundColor(.green)
                    } else if committedStrokesCount > testTargetCount {
                        Text("\(committedStrokesCount) / \(testTargetCount) (Target exceeded)")
                            .font(.footnote)
                            .foregroundColor(.orange)
                    } else {
                        Text("Progress: \(committedStrokesCount) / \(testTargetCount)")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(UIColor.tertiarySystemBackground))

                // Native PKCanvasView
                PencilKitCanvasRepresentable(
                    canvasView: $canvasView,
                    onDrawingChanged: { drawing in
                        committedStrokesCount = drawing.strokes.count
                        lastStrokeTimestamp = Date()
                    }
                )
                .background(Color(UIColor.systemBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                )
                .padding(12)
            }
        }
    }

    private func clearCanvas() {
        canvasView.drawing = PKDrawing()
        committedStrokesCount = 0
    }
}

/// SwiftUI wrapper for UIKit's PKCanvasView
struct PencilKitCanvasRepresentable: UIViewRepresentable {
    @Binding var canvasView: PKCanvasView
    var onDrawingChanged: (PKDrawing) -> Void

    func makeUIView(context: Context) -> PKCanvasView {
        canvasView.tool = PKInkingTool(.pen, color: .label, width: 3)
        // Pen-only mode: reject finger drawing so finger gestures don't generate strokes
        canvasView.drawingPolicy = .pencilOnly
        canvasView.delegate = context.coordinator
        canvasView.backgroundColor = .clear
        canvasView.isOpaque = false
        // Avoid scrolling interference during rapid tapping
        canvasView.isScrollEnabled = false
        return canvasView
    }

    func updateUIView(_ uiView: PKCanvasView, context: Context) {
        // No-op for continuous drawing
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onDrawingChanged: onDrawingChanged)
    }

    class Coordinator: NSObject, PKCanvasViewDelegate {
        var onDrawingChanged: (PKDrawing) -> Void

        init(onDrawingChanged: @escaping (PKDrawing) -> Void) {
            self.onDrawingChanged = onDrawingChanged
        }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            onDrawingChanged(canvasView.drawing)
        }
    }
}
