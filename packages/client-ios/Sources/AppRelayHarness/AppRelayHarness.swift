import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public typealias AppRelayHandler = ([String: Any]) async throws -> [String: Any]

@MainActor
public final class AppRelayHarness {
    private let appId: String
    private let platform: String
    private let token: String?
    private var handlers: [String: AppRelayHandler] = [:]
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?

    public init(appId: String, platform: String = "ios", token: String? = nil) {
        self.appId = appId
        self.platform = platform
        self.token = token
    }

    public func register(method: String, handler: @escaping AppRelayHandler) {
        handlers[method] = handler
        #if DEBUG
        if task != nil {
            Task { [weak self] in
                try? await self?.sendRegistration()
            }
        }
        #endif
    }

    public func connect(to urlString: String = "ws://127.0.0.1:4000") {
        #if DEBUG
        guard let url = URL(string: urlString) else {
            assertionFailure("Invalid App Relay hub URL: \(urlString)")
            return
        }

        disconnect()
        let socketTask = URLSession.shared.webSocketTask(with: url)
        task = socketTask
        socketTask.resume()

        receiveTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.sendRegistration()
                try await self.receiveLoop(socketTask)
            } catch {}
        }
        #endif
    }

    public func disconnect() {
        #if DEBUG
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        #endif
    }

    #if DEBUG
    private func sendRegistration() async throws {
        var message: [String: Any] = [
            "type": "register",
            "app": appId,
            "platform": platform,
            "methods": handlers.keys.sorted()
        ]
        if let token { message["token"] = token }
        try await sendJSON(message)
    }

    private func receiveLoop(_ socketTask: URLSessionWebSocketTask) async throws {
        while !Task.isCancelled {
            let message = try await socketTask.receive()
            let text: String
            switch message {
            case .string(let value):
                text = value
            case .data(let data):
                guard let value = String(data: data, encoding: .utf8) else { continue }
                text = value
            @unknown default:
                continue
            }
            await handle(text)
        }
    }

    private func handle(_ text: String) async {
        guard
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let id = object["id"] as? NSNumber,
            let method = object["method"] as? String
        else { return }

        guard let handler = handlers[method] else {
            try? await sendJSON([
                "id": id,
                "error": ["code": "METHOD_NOT_FOUND", "message": "Unknown method '\(method)'"],
                "result": NSNull()
            ])
            return
        }

        do {
            let params = object["params"] as? [String: Any] ?? [:]
            let result = try await handler(params)
            try await sendJSON(["id": id, "result": result, "error": NSNull()])
        } catch {
            try? await sendJSON([
                "id": id,
                "result": NSNull(),
                "error": ["code": "HANDLER_ERROR", "message": error.localizedDescription]
            ])
        }
    }

    private func sendJSON(_ object: [String: Any]) async throws {
        guard let task else { return }
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(text))
    }
    #endif
}
