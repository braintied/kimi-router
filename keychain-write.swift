import Foundation
import Security

struct KeychainEntry: Decodable {
    let service: String
    let account: String
    let secret: String
}

func fail(_ message: String, status: OSStatus? = nil) -> Never {
    if let status {
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "unknown Keychain error"
        FileHandle.standardError.write(Data("\(message): \(detail) (\(status))\n".utf8))
    } else {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }
    exit(1)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let entries: [KeychainEntry]
do {
    entries = try JSONDecoder().decode([KeychainEntry].self, from: input)
} catch {
    fail("Could not decode Keychain write request")
}

var trustedSecurity: SecTrustedApplication?
let trustedStatus = SecTrustedApplicationCreateFromPath("/usr/bin/security", &trustedSecurity)
if trustedStatus != errSecSuccess { fail("Could not create trusted application", status: trustedStatus) }

for entry in entries {
    let lookup: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: entry.service,
        kSecAttrAccount: entry.account,
    ]
    let value = Data(entry.secret.utf8)
    let updated = SecItemUpdate(lookup as CFDictionary, [kSecValueData: value] as CFDictionary)
    if updated == errSecSuccess { continue }
    if updated != errSecItemNotFound {
        fail("Could not update Keychain item for \(entry.account)", status: updated)
    }

    var access: SecAccess?
    let accessStatus = SecAccessCreate(
        "Kimi Router: \(entry.account)" as CFString,
        [trustedSecurity!] as CFArray,
        &access
    )
    if accessStatus != errSecSuccess { fail("Could not create Keychain access policy", status: accessStatus) }

    var add = lookup
    add[kSecValueData] = value
    add[kSecAttrLabel] = "Kimi Router: \(entry.account)"
    add[kSecAttrAccess] = access
    let added = SecItemAdd(add as CFDictionary, nil)
    if added != errSecSuccess { fail("Could not add Keychain item for \(entry.account)", status: added) }
}

print("ok")
