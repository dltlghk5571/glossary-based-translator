"""Run the glossary translation pipeline over eval_data/cases and score the
output with rule-based (no-API-key-needed) metrics.

Example:
    python evaluate.py --cases eval_data/cases --glossary glossary.csv \\
        --out eval_data/results --no-interactive --split optimization \\
        --summary eval_data/eval_summary.json
"""
import argparse
import json
import os

import eval_metrics
import glossary_manager as gm
import translation_graph
import llm_providers


def _load_case(case_dir):
    with open(os.path.join(case_dir, "input.txt"), "r", encoding="utf-8") as f:
        input_text = f.read()
    with open(os.path.join(case_dir, "reference.txt"), "r", encoding="utf-8") as f:
        reference_text = f.read()
    with open(os.path.join(case_dir, "metadata.json"), "r", encoding="utf-8") as f:
        metadata = json.load(f)
    return input_text, reference_text, metadata


def discover_cases(cases_dir, case_id=None, split=None):
    ids = sorted(
        d for d in os.listdir(cases_dir)
        if os.path.isdir(os.path.join(cases_dir, d))
    )
    if case_id:
        ids = [i for i in ids if i == case_id]

    cases = []
    for cid in ids:
        case_dir = os.path.join(cases_dir, cid)
        try:
            input_text, reference_text, metadata = _load_case(case_dir)
        except FileNotFoundError as e:
            print(f"[skip] case {cid}: missing file ({e.filename})")
            continue
        if split and metadata.get("split") != split:
            continue
        cases.append((cid, case_dir, input_text, reference_text, metadata))
    return cases


def run_case(cid, input_text, glossary_path, generate_fns, interactive):
    result = translation_graph.run_pipeline(
        input_text, glossary_path, generate_fns,
        interactive=interactive, thread_id=f"eval-{cid}",
    )
    return {
        "prediction": result.get("final_translation", ""),
        "audit_report": result.get("audit_report", {}),
        "missing_terms": result.get("missing_terms", []),
        "candidate_terms": result.get("candidate_terms", []),
        "warnings": result.get("warnings", []),
    }


def write_case_outputs(out_case_dir, run_result, eval_report, save_predictions):
    os.makedirs(out_case_dir, exist_ok=True)
    if save_predictions:
        with open(os.path.join(out_case_dir, "prediction.txt"), "w", encoding="utf-8") as f:
            f.write(run_result["prediction"])
    with open(os.path.join(out_case_dir, "audit_report.json"), "w", encoding="utf-8") as f:
        json.dump(run_result["audit_report"], f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_case_dir, "missing_terms.json"), "w", encoding="utf-8") as f:
        json.dump(run_result["missing_terms"], f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_case_dir, "eval_report.json"), "w", encoding="utf-8") as f:
        json.dump(eval_report, f, ensure_ascii=False, indent=2)


def build_summary(eval_reports):
    n = len(eval_reports)
    if n == 0:
        return {
            "num_cases": 0, "average_glossary_compliance": 0.0,
            "total_required_terms": 0, "total_missing_required_terms": 0,
            "cases_with_warnings": [], "worst_cases": [],
            "common_missing_terms": [], "common_failure_categories": {},
        }

    total_required = sum(r["glossary_compliance"]["required_terms"] for r in eval_reports)
    total_missing = sum(len(r["glossary_compliance"]["missing_required_terms"]) for r in eval_reports)
    avg_compliance = sum(r["glossary_compliance"]["score"] for r in eval_reports) / n

    cases_with_warnings = [r["case_id"] for r in eval_reports if r["warnings"]]
    worst_cases = sorted(
        eval_reports,
        key=lambda r: (
            r["glossary_compliance"]["score"],
            -len(r["missing_term_detection"]["high_priority_missing_terms"]),
            -len(r["failure_categories"]),
        ),
    )[:5]
    worst_case_ids = [
        r["case_id"] for r in worst_cases
        if r["glossary_compliance"]["score"] < 1.0 or r["missing_term_detection"]["high_priority_missing_terms"]
    ]

    missing_term_counts = {}
    for r in eval_reports:
        for t in r["glossary_compliance"]["missing_required_terms"]:
            missing_term_counts[t] = missing_term_counts.get(t, 0) + 1
        for t in r["missing_term_detection"]["high_priority_missing_terms"]:
            missing_term_counts[t] = missing_term_counts.get(t, 0) + 1
    common_missing_terms = sorted(missing_term_counts, key=missing_term_counts.get, reverse=True)[:10]

    failure_counts = {}
    for r in eval_reports:
        for cat in r["failure_categories"]:
            failure_counts[cat] = failure_counts.get(cat, 0) + 1

    manual_review = [r["case_id"] for r in eval_reports if r["manual_review_required"]]

    return {
        "num_cases": n,
        "average_glossary_compliance": round(avg_compliance, 4),
        "total_required_terms": total_required,
        "total_missing_required_terms": total_missing,
        "cases_with_warnings": cases_with_warnings,
        "worst_cases": worst_case_ids,
        "common_missing_terms": common_missing_terms,
        "common_failure_categories": failure_counts,
        "manual_review_required_cases": manual_review,
    }


def write_summary_md(summary, eval_reports, path):
    opt = [r for r in eval_reports if r["split"] == "optimization"]
    hold = [r for r in eval_reports if r["split"] == "holdout"]
    fmt_loss_cases = [r["case_id"] for r in eval_reports if "format_loss" in r["failure_categories"]]

    lines = [
        "# Evaluation Summary",
        "",
        f"- Total cases evaluated: {summary['num_cases']}",
        f"- Optimization cases: {len(opt)}",
        f"- Holdout cases: {len(hold)}",
        f"- Average glossary compliance: {summary['average_glossary_compliance']:.4f}",
        "",
        "## Cases with glossary violations",
        "",
    ]
    violation_cases = [r["case_id"] for r in eval_reports if r["glossary_compliance"]["missing_required_terms"]]
    lines.append(", ".join(violation_cases) if violation_cases else "(none)")

    lines += ["", "## Cases with format loss", ""]
    lines.append(", ".join(fmt_loss_cases) if fmt_loss_cases else "(none)")

    lines += ["", "## Cases with the most missing terms", ""]
    lines.append(", ".join(summary["worst_cases"]) if summary["worst_cases"] else "(none)")

    lines += ["", "## Commonly missing terms", ""]
    lines.append(", ".join(summary["common_missing_terms"]) if summary["common_missing_terms"] else "(none)")

    lines += ["", "## Common failure categories", ""]
    if summary["common_failure_categories"]:
        for cat, count in sorted(summary["common_failure_categories"].items(), key=lambda x: -x[1]):
            lines.append(f"- {cat}: {count}")
    else:
        lines.append("(none)")

    lines += ["", "## Cases requiring manual review", ""]
    lines.append(", ".join(summary.get("manual_review_required_cases", [])) or "(none)")

    lines += ["", "## Suggested next actions", ""]
    if summary["common_missing_terms"]:
        lines.append(f"- Add glossary coverage/aliases for: {', '.join(summary['common_missing_terms'][:5])}")
    if fmt_loss_cases:
        lines.append("- Investigate format preservation (dates/times/numbers/urls/mentions/hashtags) in prompt/audit.")
    if not summary["common_missing_terms"] and not fmt_loss_cases:
        lines.append("- No major issues detected in this run.")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def _build_arg_parser():
    p = argparse.ArgumentParser(description="Evaluate the glossary translation pipeline over eval_data/cases.")
    p.add_argument("--cases", default="eval_data/cases")
    p.add_argument("--glossary", default="glossary.csv")
    p.add_argument("--out", default="eval_data/results")
    p.add_argument("--case-id", default=None)
    p.add_argument("--split", choices=["optimization", "holdout"], default=None)
    p.add_argument("--save-predictions", dest="save_predictions", action="store_true", default=True)
    p.add_argument("--no-save-predictions", dest="save_predictions", action="store_false")
    p.add_argument("--summary", default="eval_data/eval_summary.json")

    interactive_group = p.add_mutually_exclusive_group()
    interactive_group.add_argument("--interactive", dest="interactive", action="store_true", default=False)
    interactive_group.add_argument("--no-interactive", dest="interactive", action="store_false")
    return p


def main():
    args = _build_arg_parser().parse_args()

    cases = discover_cases(args.cases, case_id=args.case_id, split=args.split)
    if not cases:
        print("No matching cases found.")
        return

    generate_fns = llm_providers.build_generate_fns()
    eval_reports = []

    for cid, case_dir, input_text, reference_text, metadata in cases:
        print(f"[case {cid}] translating...")
        run_result = run_case(cid, input_text, args.glossary, generate_fns, args.interactive)
        glossary_rows = gm.load_glossary(args.glossary)

        eval_report = eval_metrics.evaluate_case(
            cid, metadata.get("split", "optimization"), input_text, reference_text,
            run_result["prediction"], glossary_rows, run_result["candidate_terms"],
            run_result["missing_terms"], metadata, run_result["warnings"],
        )
        eval_reports.append(eval_report)

        out_case_dir = os.path.join(args.out, cid)
        write_case_outputs(out_case_dir, run_result, eval_report, args.save_predictions)
        print(f"[case {cid}] glossary_compliance={eval_report['glossary_compliance']['score']:.2f} "
              f"failures={eval_report['failure_categories']}")

    summary = build_summary(eval_reports)
    os.makedirs(os.path.dirname(args.summary) or ".", exist_ok=True)
    with open(args.summary, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    md_path = os.path.splitext(args.summary)[0] + ".md"
    write_summary_md(summary, eval_reports, md_path)

    print(f"\nEvaluated {len(eval_reports)} case(s).")
    print(f"Average glossary compliance: {summary['average_glossary_compliance']:.4f}")
    print(f"Summary written to {args.summary} and {md_path}")


if __name__ == "__main__":
    main()
