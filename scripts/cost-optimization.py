#!/usr/bin/env python3
"""
Cost and Multi-Criteria Optimization Script for Logistics Disruption Triage.
Ticket #09: Evaluates alternate suppliers by weighting Landed Cost (40%),
Lead Time (30%), and Reliability Score (30%) to produce ranked recommendations.
"""

import argparse
import json
import sys
from typing import Any, Dict, List

# Default weight distribution per SOP
WEIGHT_COST = 0.40
WEIGHT_LEAD_TIME = 0.30
WEIGHT_RELIABILITY = 0.30

# Default primary baseline for SKU-4471
DEFAULT_PRIMARY = {
    "sku": "SKU-4471",
    "primary_supplier_name": "Oceanic Bearings Ltd",
    "primary_unit_cost": 42.50,
    "current_stock": 140,
    "daily_burn_rate": 10,
    "days_of_supply": 14,
}

# Default candidate suppliers for SKU-4471
DEFAULT_CANDIDATES = [
    {
        "supplier_id": 2,
        "supplier_name": "Pacific Marine Supply",
        "region": "Southeast Asia (Singapore)",
        "unit_cost": 55.00,
        "lead_time_days": 10,
        "reliability_score": 0.94,
        "carrier_allocated": "Maersk Pacific Lines",
        "carrier_rate_teu": 2850.00,
    },
    {
        "supplier_id": 3,
        "supplier_name": "IndoPacific Parts Corp",
        "region": "Southeast Asia (Jakarta)",
        "unit_cost": 52.00,
        "lead_time_days": 12,
        "reliability_score": 0.91,
        "carrier_allocated": "Evergreen Express Maritime",
        "carrier_rate_teu": 1920.00,
    },
    {
        "supplier_id": 4,
        "supplier_name": "Baltic Industrial Components",
        "region": "Northern Europe (Gdansk)",
        "unit_cost": 44.00,
        "lead_time_days": 28,
        "reliability_score": 0.78,
        "carrier_allocated": "Standard Rail/Feeder",
        "carrier_rate_teu": 1600.00,
    },
    {
        "supplier_id": 5,
        "supplier_name": "Atlantic Precision Bearings",
        "region": "Western Europe (Rotterdam)",
        "unit_cost": 72.00,
        "lead_time_days": 5,
        "reliability_score": 0.98,
        "carrier_allocated": "CMA CGM Asia Expedited",
        "carrier_rate_teu": 4200.00,
    },
]


def calculate_landed_cost(candidate: Dict[str, Any], units: int = 500) -> float:
    """Calculates total landed cost per unit including freight carrier allocation."""
    unit_cost = float(candidate["unit_cost"])
    carrier_rate = float(candidate.get("carrier_rate_teu", 0.0))
    # Assume 1 TEU holds ~2,500 units of SKU-4471
    freight_per_unit = carrier_rate / 2500.0 if carrier_rate > 0 else 0.0
    return round(unit_cost + freight_per_unit, 2)


def optimize_suppliers(
    candidates: List[Dict[str, Any]],
    primary: Dict[str, Any] = DEFAULT_PRIMARY,
    order_units: int = 500,
) -> List[Dict[str, Any]]:
    """Runs multi-criteria scoring on alternate suppliers."""
    if not candidates:
        return []

    max_cost_ceiling = primary["primary_unit_cost"] * 1.50  # +50% ceiling ($63.75)
    days_of_supply = primary.get("days_of_supply", 14)

    evaluated: List[Dict[str, Any]] = []

    # 1. Compute landed costs and check guardrail eligibility
    for c in candidates:
        landed = calculate_landed_cost(c, order_units)
        lead_time = int(c["lead_time_days"])
        rel = float(c["reliability_score"])
        unit_cost = float(c["unit_cost"])

        # Check guardrails
        violations = []
        if unit_cost > max_cost_ceiling:
            violations.append(
                f"Exceeds +50% cost ceiling (${unit_cost:.2f} > ${max_cost_ceiling:.2f})"
            )
        if lead_time > days_of_supply:
            violations.append(
                f"Exceeds stockout window ({lead_time}d > {days_of_supply}d DoS)"
            )
        if rel < 0.75:
            violations.append(f"Reliability below 0.75 floor ({rel:.2f})")
        if lead_time > 30:
            violations.append(f"Lead time exceeds 30-day cap ({lead_time}d)")

        eligible = len(violations) == 0

        evaluated.append(
            {
                "supplier_id": c.get("supplier_id"),
                "supplier_name": c["supplier_name"],
                "region": c.get("region", "Global"),
                "unit_cost": unit_cost,
                "landed_cost": landed,
                "lead_time_days": lead_time,
                "reliability_score": rel,
                "eligible": eligible,
                "violations": violations,
                "carrier": c.get("carrier_allocated", "Standard"),
            }
        )

    # 2. Extract min/max bounds for normalization across all candidates
    costs = [e["landed_cost"] for e in evaluated]
    leads = [e["lead_time_days"] for e in evaluated]
    rels = [e["reliability_score"] for e in evaluated]

    min_cost, max_cost = min(costs), max(costs)
    min_lead, max_lead = min(leads), max(leads)
    min_rel, max_rel = min(rels), max(rels)

    # 3. Calculate normalized multi-criteria scores
    for e in evaluated:
        # Inverted cost score: lower landed cost yields higher score
        if max_cost == min_cost:
            norm_cost = 1.0
        else:
            norm_cost = (max_cost - e["landed_cost"]) / (max_cost - min_cost)

        # Inverted lead time score: shorter lead time yields higher score
        if max_lead == min_lead:
            norm_lead = 1.0
        else:
            norm_lead = (max_lead - e["lead_time_days"]) / (max_lead - min_lead)

        # Direct reliability score: higher reliability yields higher score
        if max_rel == min_rel:
            norm_rel = 1.0
        else:
            norm_rel = (e["reliability_score"] - min_rel) / (max_rel - min_rel)

        # Base composite score
        base_score = (
            WEIGHT_COST * norm_cost
            + WEIGHT_LEAD_TIME * norm_lead
            + WEIGHT_RELIABILITY * norm_rel
        )

        # Disqualified suppliers receive penalty
        if not e["eligible"]:
            composite_score = round(base_score * 0.20, 4)
        else:
            composite_score = round(base_score, 4)

        e["norm_cost"] = round(norm_cost, 4)
        e["norm_lead"] = round(norm_lead, 4)
        e["norm_rel"] = round(norm_rel, 4)
        e["composite_score"] = composite_score

    # 4. Rank candidates: eligible candidates first sorted by composite_score desc
    ranked = sorted(
        evaluated,
        key=lambda x: (1 if x["eligible"] else 0, x["composite_score"]),
        reverse=True,
    )

    for i, item in enumerate(ranked, start=1):
        item["rank"] = i

    return ranked


def render_markdown_table(ranked: List[Dict[str, Any]]) -> str:
    """Renders human-readable ranked comparison table."""
    lines = [
        "| Rank | Supplier Name | Landed Cost | Lead Time | Reliability | Composite Score | Status / Guardrails |",
        "|:---:|:---|:---:|:---:|:---:|:---:|:---|",
    ]
    for r in ranked:
        cost_str = f"${r['landed_cost']:.2f}"
        lead_str = f"{r['lead_time_days']} days"
        rel_str = f"{r['reliability_score']:.2f}"
        score_str = f"{r['composite_score']:.4f}"
        if r["eligible"]:
            status_str = "✅ Compliant (Top Recommendation)" if r["rank"] == 1 else "✅ Compliant"
        else:
            status_str = f"❌ Ineligible ({'; '.join(r['violations'])})"

        lines.append(
            f"| {r['rank']} | {r['supplier_name']} | {cost_str} | {lead_str} | {rel_str} | {score_str} | {status_str} |"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Multi-Criteria Supplier Cost Optimization")
    parser.add_argument("--sku", default="SKU-4471", help="Target SKU")
    parser.add_argument("--units", type=int, default=500, help="Order quantity units")
    parser.add_argument("--json", action="store_true", help="Output raw JSON format")
    parser.add_argument("--input", help="JSON string or file path containing candidate suppliers")
    args = parser.parse_args()

    candidates = DEFAULT_CANDIDATES
    primary = DEFAULT_PRIMARY

    if args.input:
        try:
            if args.input.strip().startswith("[") or args.input.strip().startswith("{"):
                loaded = json.loads(args.input)
            else:
                with open(args.input, "r") as f:
                    loaded = json.load(f)
            if isinstance(loaded, list):
                candidates = loaded
            elif isinstance(loaded, dict) and "candidates" in loaded:
                candidates = loaded["candidates"]
                if "primary" in loaded:
                    primary = loaded["primary"]
        except Exception as err:
            print(f"Warning: Failed to parse custom input: {err}", file=sys.stderr)

    ranked = optimize_suppliers(candidates, primary, args.units)

    if args.json:
        print(json.dumps({"sku": args.sku, "ranked_suppliers": ranked}, indent=2))
    else:
        print("\n================================================================================")
        print(f"📊 MULTI-CRITERIA SUPPLIER OPTIMIZATION REPORT ({args.sku})")
        print(f"Weights: Landed Cost: {int(WEIGHT_COST*100)}% | Lead Time: {int(WEIGHT_LEAD_TIME*100)}% | Reliability: {int(WEIGHT_RELIABILITY*100)}%")
        print(f"Order Volume: {args.units} units | Stockout Horizon: {primary['days_of_supply']} days")
        print("================================================================================\n")
        print(render_markdown_table(ranked))
        print("\n🏆 Top Ranked Recommendation:")
        top = ranked[0] if ranked else None
        if top and top["eligible"]:
            print(f"   Supplier: {top['supplier_name']} (Rank #{top['rank']})")
            print(f"   Landed Cost: ${top['landed_cost']:.2f}/unit | Lead Time: {top['lead_time_days']} days | Reliability: {top['reliability_score']:.2f}")
            print(f"   Composite Score: {top['composite_score']:.4f}")
        print("================================================================================\n")


if __name__ == "__main__":
    main()
