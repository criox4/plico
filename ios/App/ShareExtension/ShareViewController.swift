// Plico Share Extension: takes a screenshot/photo or text shared from another app, hands it to Plico through the
// App Group (key "share-target-data", read by @capgo/capacitor-share-target), then opens Plico to the add screen.
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let appGroup = "group.app.plico"
    private var texts: [String] = []
    private var files: [[String: Any]] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        Task { await collect(); finish() }
    }

    private func collect() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), let file = await saveImage(provider) {
                files.append(file)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                      let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                texts.append(url.absoluteString)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                texts.append(text)
            }
        }
    }

    /// Copies the image into the shared container as JPEG (screenshots arrive as PNG, photos as HEIC).
    private func saveImage(_ provider: NSItemProvider) async -> [String: Any]? {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("shared", isDirectory: true) else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier)
        var image: UIImage?
        if let url = loaded as? URL { image = UIImage(contentsOfFile: url.path) }
        else if let data = loaded as? Data { image = UIImage(data: data) }
        else if let img = loaded as? UIImage { image = img }
        guard let jpeg = image?.jpegData(compressionQuality: 0.85) else { return nil }
        let dest = dir.appendingPathComponent("\(UUID().uuidString).jpg")
        guard (try? jpeg.write(to: dest)) != nil else { return nil }
        return ["uri": dest.absoluteString, "name": dest.lastPathComponent, "mimeType": "image/jpeg"]
    }

    private func finish() {
        let defaults = UserDefaults(suiteName: appGroup)
        defaults?.set(["title": "", "texts": texts, "files": files], forKey: "share-target-data")
        defaults?.synchronize()
        // Extensions can't call UIApplication.shared; walk the responder chain to reach it.
        if let url = URL(string: "plico://share") {
            var r: UIResponder? = self
            while let next = r { if let app = next as? UIApplication { app.open(url); break }; r = next.next }
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
}
