import Foundation
@testable import HerdrKit

// Twin of herdr-core `claude_session_name_rule_under_picker`: a named Claude Code session (one sent to its background
// service, or renamed) draws its name in a rule under the picker, below the key line ("────── Flockbook plus PR 1
// continuation ─", live 2026-11-13). The exact compares took that rule for the key line and refused every answer.
// The rule is drawing under the picker: they look above it. Any other line there still refuses.
@MainActor func checksClaudeNameRule() {
    func req(_ id: String, _ questions: String) -> QuestionRequest {
        ClaudeQuestionHook.record(Data((#"{"session_id":"sess-nr","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":""# + id + #"","tool_input":{"questions":["# + questions + #"]}}"#).utf8), time: Date())!.request
    }
    let q = req("toolu_name", #"{"question":"Ready?","header":"Capture","multiSelect":false,"options":[{"label":"Done, waited 15 s","description":"Answered in the terminal after the capture."},{"label":"Stop debugging","description":"Leave the parked-answer bug for later."}]}"#)
    let picker = ClaudePickerSim([.init(header: "Capture", text: "Ready?", options: [("Done, waited 15 s", "Answered in the terminal after the capture."),
                                                                                       ("Stop debugging", "Leave the parked-answer bug for later.")], multi: false)]).render()
    let screen = { (under: String) in under.isEmpty ? picker : picker + "\n" + under }
    let e = { (s: String) in QuestionAdapter.claudeExact(q, question: 0, screen: s, other: nil, focus: .any, checks: nil) }
    let named = screen("────────────────────────────────────────────── Flockbook plus PR 1 continuation ─")
    check(e(screen("")), "name rule: none, as before")
    check(e(named), "name rule: the session name under the key line matches")
    check(e(named + "\n\n   "), "name rule: blank lines after the rule are ignored too")
    check(QuestionAdapter.shows(q, question: 0, screen: named, focus: .any), "name rule: shows() uses the same exact compare")
    check(e(screen("───── a name with ─ dashes ─")), "name rule: a name may hold a dash")
    check(!e(screen("some text")), "name rule: other text under the key line refuses")
    check(!e(screen("───── ─")), "name rule: a rule with no name is not one")
    check(!e(screen("───── ─ ─")), "name rule: a name of dashes only is not one")
    check(!e(screen("── short ─")), "name rule: fewer than 3 dashes before the name is not one")
    check(!e(screen("Flockbook plus PR 1 continuation ─")), "name rule: a name without its rule refuses")
    check(!e(named + "\n    ───── another name ─"), "name rule: one rule only")

    let r = req("toolu_name_r", #"{"question":"Which size?","header":"Size","multiSelect":false,"options":[{"label":"Small","description":"s"},{"label":"Large","description":"l"}]},{"question":"Which toppings?","header":"Tops","multiSelect":true,"options":[{"label":"Cheese","description":"y"},{"label":"Ham","description":"p"}]}"#)
    let review = { (under: String) in """
    ─────────────────────────────────────────────────────────────────────────────
    ←  ☒ Size  ☒ Tops  ✔ Submit  →

    Review your answers

     ● Which size?
       → Large
     ● Which toppings?
       → Cheese

    Ready to submit your answers?

    ❯ 1. Submit answers
      2. Cancel
    \(under)
    """ }
    let a = [QuestionAnswer(picks: [1]), QuestionAnswer(picks: [0])]
    check(QuestionAdapter.claudeReviewExact(r, answers: a, screen: review("")), "name rule review: none, as before")
    check(QuestionAdapter.claudeReviewExact(r, answers: a, screen: review("──────────────────── Flockbook plus PR 1 continuation ─")), "name rule review: matches")
    check(!QuestionAdapter.claudeReviewExact(r, answers: a, screen: review("some text")), "name rule review: other text refuses")
}
