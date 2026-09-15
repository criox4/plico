// Plico home-screen widget: your balance and top groups. Reads the summary the app copies into the
// App Group ("widget" in group.app.plico) whenever Plico goes to the background.
import SwiftUI
import WidgetKit

struct Row: Codable, Hashable { let name: String; let emoji: String; let amount: String; let tone: String }
struct Summary: Codable { let title: String; let amount: String; let tone: String; let groups: [Row]; let signedIn: Bool }

struct Entry: TimelineEntry { let date: Date; let summary: Summary? }

struct Provider: TimelineProvider {
    private func load() -> Summary? {
        guard let raw = UserDefaults(suiteName: "group.app.plico")?.string(forKey: "widget"), let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Summary.self, from: data)
    }
    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, summary: Summary(title: "You’re owed", amount: "₹2,840", tone: "pos", groups: [Row(name: "Flat 404", emoji: "🏠", amount: "₹1,400", tone: "pos")], signedIn: true))
    }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(context.isPreview ? placeholder(in: context) : Entry(date: .now, summary: load())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: .now, summary: load())], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

private let purple = Color(red: 0x6C / 255, green: 0x5C / 255, blue: 0xE7 / 255)
private func tint(_ tone: String) -> Color {
    tone == "pos" ? Color(red: 0x0B / 255, green: 0x7A / 255, blue: 0x56 / 255) : tone == "neg" ? Color(red: 0xC8 / 255, green: 0x37 / 255, blue: 0x4A / 255) : .primary
}

struct PlicoWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("plico").font(.system(size: 13, weight: .heavy, design: .rounded)).foregroundStyle(purple)
            if let s = entry.summary, s.signedIn {
                Text(s.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(s.amount).font(.system(size: 28, weight: .bold, design: .rounded)).monospacedDigit().foregroundStyle(tint(s.tone)).minimumScaleFactor(0.5).lineLimit(1)
                if family != .systemSmall {
                    ForEach(s.groups, id: \.self) { g in
                        HStack {
                            Text((g.emoji.isEmpty ? "" : g.emoji + " ") + g.name).font(.subheadline).lineLimit(1)
                            Spacer()
                            Text(g.amount).font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(tint(g.tone))
                        }
                    }
                }
            } else {
                Text("Open Plico to sign in").font(.subheadline)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(URL(string: "plico://open"))
        .widgetBackground()
    }
}

private extension View {
    /// iOS 17 wants a container background; earlier versions just pad.
    @ViewBuilder func widgetBackground() -> some View {
        if #available(iOS 17.0, *) { containerBackground(for: .widget) { Color(.systemBackground) } }
        else { padding().background(Color(.systemBackground)) }
    }
}

@main
struct PlicoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "PlicoBalance", provider: Provider()) { PlicoWidgetView(entry: $0) }
            .configurationDisplayName("Plico balance")
            .description("What you’re owed or owe, and your top groups.")
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}
