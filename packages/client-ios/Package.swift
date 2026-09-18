// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AppRelayHarness",
    platforms: [
        .iOS(.v15),
        .macOS(.v12)
    ],
    products: [
        .library(name: "AppRelayHarness", targets: ["AppRelayHarness"])
    ],
    targets: [
        .target(name: "AppRelayHarness")
    ]
)
