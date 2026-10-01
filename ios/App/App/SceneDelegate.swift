import UIKit
import Capacitor
import WidgetKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PlicoViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// Hand the home-screen widget the latest summary (written by the web app via Capacitor Preferences).
    func sceneDidEnterBackground(_ scene: UIScene) {
        guard let summary = UserDefaults.standard.string(forKey: "CapacitorStorage.widget") else { return }
        UserDefaults(suiteName: "group.app.plico")?.set(summary, forKey: "widget")
        WidgetCenter.shared.reloadAllTimelines()
    }
}
