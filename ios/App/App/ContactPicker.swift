import Capacitor
import ContactsUI

/// The app's bridge view controller: the one place local plugins get registered with Capacitor.
class PlicoViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ContactPickerPlugin())
    }
}

/// The system contact picker. It runs out of process and hands back only the contact chosen, so there's no
/// permission prompt and no NSContactsUsageDescription (CNContactPickerViewController docs).
@objc(ContactPickerPlugin)
class ContactPickerPlugin: CAPPlugin, CAPBridgedPlugin, CNContactPickerDelegate {
    let identifier = "ContactPickerPlugin"
    let jsName = "ContactPicker"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise)]
    private var pending: CAPPluginCall?

    @objc func pick(_ call: CAPPluginCall) {
        pending?.resolve() // a second tap while open: the first one counts as cancelled
        pending = call
        DispatchQueue.main.async {
            let picker = CNContactPickerViewController()
            picker.delegate = self
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
        pending?.resolve([
            "name": CNContactFormatter.string(from: contact, style: .fullName) ?? "",
            "phones": contact.phoneNumbers.map { $0.value.stringValue },
            "email": contact.emailAddresses.first.map { $0.value as String } ?? "",
        ])
        pending = nil
    }

    func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        pending?.resolve()
        pending = nil
    }
}
