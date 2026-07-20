import Foundation
import Security

struct Mapping: Decodable {
    let source: String
    let target: String
}

struct Request: Decodable {
    let operation: String
    let service: String
    let mappings: [Mapping]
}

struct Result: Encodable {
    let ok: Bool
    let createdTargets: [String]
    let reused: Int
    let deleted: Int
    let failed: Int
    let total: Int
    let identifying: Int
}

func emit(_ result: Result) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(result) else { exit(1) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

func validate(_ value: String, field: String, index: Int) {
    if value.isEmpty || value.utf8.contains(where: { $0 < 0x20 || $0 == 0x7f }) {
        fail("Invalid \(field) at mapping position \(index + 1)")
    }
}

func readSecret(service: String, account: String) throws -> Data? {
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
        kSecReturnData: true,
        kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    if status != errSecSuccess {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    return result as? Data
}

func deleteItem(service: String, account: String) -> OSStatus {
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
    ]
    return SecItemDelete(query as CFDictionary)
}

func addTarget(service: String, account: String, secret: Data) throws {
    var trustedSecurity: SecTrustedApplication?
    let trustedStatus = SecTrustedApplicationCreateFromPath("/usr/bin/security", &trustedSecurity)
    if trustedStatus != errSecSuccess {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(trustedStatus))
    }
    var access: SecAccess?
    let accessStatus = SecAccessCreate(
        "Kimi Router: \(account)" as CFString,
        [trustedSecurity!] as CFArray,
        &access
    )
    if accessStatus != errSecSuccess {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(accessStatus))
    }
    let item: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
        kSecAttrLabel: "Kimi Router: \(account)",
        kSecAttrAccess: access!,
        kSecValueData: secret,
    ]
    let status = SecItemAdd(item as CFDictionary, nil)
    if status != errSecSuccess {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
}

let requestData = FileHandle.standardInput.readDataToEndOfFile()
let request: Request
do {
    request = try JSONDecoder().decode(Request.self, from: requestData)
} catch {
    fail("Could not decode Keychain relabel request")
}

if request.service.isEmpty || (request.mappings.isEmpty && request.operation != "audit") {
    fail("Keychain relabel request is incomplete")
}
for (index, mapping) in request.mappings.enumerated() {
    validate(mapping.source, field: "source", index: index)
    validate(mapping.target, field: "target", index: index)
}

switch request.operation {
case "copy":
    var created: [String] = []
    var reused = 0
    do {
        for (index, mapping) in request.mappings.enumerated() {
            guard let sourceSecret = try readSecret(service: request.service, account: mapping.source) else {
                throw NSError(domain: "KimiRouterRelabel", code: index + 1)
            }
            if let targetSecret = try readSecret(service: request.service, account: mapping.target) {
                if targetSecret != sourceSecret {
                    throw NSError(domain: "KimiRouterRelabel", code: index + 1)
                }
                reused += 1
                continue
            }
            try addTarget(service: request.service, account: mapping.target, secret: sourceSecret)
            guard let verified = try readSecret(service: request.service, account: mapping.target),
                  verified == sourceSecret else {
                throw NSError(domain: "KimiRouterRelabel", code: index + 1)
            }
            created.append(mapping.target)
        }
    } catch {
        for target in created { _ = deleteItem(service: request.service, account: target) }
        fail("Keychain copy failed; newly created aliases were rolled back")
    }
    emit(Result(
        ok: true, createdTargets: created, reused: reused, deleted: 0,
        failed: 0, total: 0, identifying: 0
    ))

case "delete-sources":
    var deleted = 0
    var failed = 0
    for mapping in request.mappings where mapping.source != mapping.target {
        let status = deleteItem(service: request.service, account: mapping.source)
        if status == errSecSuccess { deleted += 1 }
        else if status != errSecItemNotFound { failed += 1 }
    }
    emit(Result(
        ok: failed == 0, createdTargets: [], reused: 0, deleted: deleted,
        failed: failed, total: 0, identifying: 0
    ))
    if failed > 0 { exit(2) }

case "delete-targets":
    var deleted = 0
    var failed = 0
    for mapping in request.mappings {
        let status = deleteItem(service: request.service, account: mapping.target)
        if status == errSecSuccess { deleted += 1 }
        else if status != errSecItemNotFound { failed += 1 }
    }
    emit(Result(
        ok: failed == 0, createdTargets: [], reused: 0, deleted: deleted,
        failed: failed, total: 0, identifying: 0
    ))
    if failed > 0 { exit(2) }

case "audit":
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: request.service,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitAll,
    ]
    var rawResult: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &rawResult)
    if status == errSecItemNotFound {
        emit(Result(
            ok: true, createdTargets: [], reused: 0, deleted: 0,
            failed: 0, total: 0, identifying: 0
        ))
        break
    }
    if status != errSecSuccess { fail("Could not audit Keychain account metadata") }
    let dictionaries: [[CFString: Any]]
    if let many = rawResult as? [[CFString: Any]] {
        dictionaries = many
    } else if let one = rawResult as? [CFString: Any] {
        dictionaries = [one]
    } else {
        fail("Keychain metadata audit returned an unexpected result")
    }
    let accounts = dictionaries.compactMap { $0[kSecAttrAccount] as? String }
    let identifying = accounts.filter { $0.contains("@") }.count
    emit(Result(
        ok: identifying == 0, createdTargets: [], reused: 0, deleted: 0,
        failed: 0, total: accounts.count, identifying: identifying
    ))
    if identifying > 0 { exit(2) }

default:
    fail("Unsupported Keychain relabel operation")
}
