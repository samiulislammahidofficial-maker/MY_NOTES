// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PencilKitBenchmark",
    platforms: [
        .iOS(.v15)
    ],
    products: [
        .executable(
            name: "PencilKitBenchmark",
            targets: ["PencilKitBenchmark"]
        )
    ],
    targets: [
        .executableTarget(
            name: "PencilKitBenchmark",
            path: ".",
            sources: ["PencilKitBenchmarkApp.swift"]
        )
    ]
)
