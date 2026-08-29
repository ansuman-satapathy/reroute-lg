#!/usr/bin/env python3
"""
Cost and Multi-Criteria Optimization Script for Logistics Disruption Triage.
Ticket #09: Evaluates alternate suppliers by weighting Landed Cost (40%),
Lead Time (30%), and Reliability Score (30%) to produce ranked recommendations.
"""

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

# Default weight distribution per SOP
WEIGHT_COST = 0.40
WEIGHT_LEAD_TIME = 0.30
WEIGHT_RELIABILITY = 0.30

# System-of-record primary baseline for SKU-4471 (synchronized with db/seed.sql and SKILL.md)
DEFAULT_PRIMARY = {
    "sku": "SKU-4471",
    "primary_supplier_name": "Oceanic Bearings Ltd",
    "primary_unit_cost": 42.50,
    "current_stock": 140,
    "daily_burn_rate": 10,
    "days_of_supply": 14,
}

# System-of-record candidate alternate suppliers for SKU-4471 (from db/seed.sql)
DEFAULT_CANDIDATES = [
    {
        "supplier_id": 4,
        "supplier_name": "IndoPacific Parts Corp",
        "region": "Southeast Asia",
        "unit_cost": 47.50,
        "lead_time_days": 12,
        "reliability_score": 0.89,
        "carrier_allocated": "Evergreen Express Maritime",
        "carrier_rate_teu": 1920.00,
    },
    {
        "supplier_id": 2,
        "supplier_name": "Pacific Marine Supply",
        "region": "South Korea",
        "unit_cost": 62.00,
        "lead_time_days": 7,
        "reliability_score": 0.82,
        "carrier_allocated": "Maersk Pacific Lines",
        "carrier_rate_teu": 2850.00,
    },
    {
        "supplier_id": 3,
        "supplier_name": "Baltic Precision Components",
        "region": "Northern Europe",
        "unit_cost": 38.00,
        "lead_time_days": 28,
        "reliability_score": 0.96,
        "carrier_allocated": "Standard Rail/Feeder",
        "carrier_rate_teu": 1600.00,
    },
]


def calculate_landed_cost(candidate: Dict[str, Any], units: int = 500) -> float:
    """Calculates total landed cost per unit including freight carrier allocation."""
    unit_cost = float(candidate["unit_cost"])
    carrier_rate = float(candidate.get("carrier_rate_teu", 0.0) or 0.0)
    # Assume 1 TEU holds ~2,500 units of standard parts
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

    # Domain invariants validation (Qodo #5)
    if order_units <= 0:
        raise ValueError(f"Order quantity units must be positive (got {order_units})")

    primary_cost = float(primary["primary_unit_cost"])
    if primary_cost <= 0:
        raise ValueError(f"Primary unit cost must be positive (got {primary_cost})")

    max_cost_ceiling = primary_cost * 1.50  # +50% ceiling
    days_of_supply = int(primary.get("days_of_supply", 14))

    evaluated: List[Dict[str, Any]] = []

    # 1. Compute landed costs, validate domain metrics, and check guardrail eligibility
    for c in candidates:
        unit_cost = float(c["unit_cost"])
        lead_time = int(c["lead_time_days"])
        rel = float(c["reliability_score"])

        # Domain metric constraints (Qodo #5)
        violations = []
        if unit_cost <= 0:
            violations.append(f"Invalid unit cost: ${unit_cost:.2f} <= 0")
        if lead_time <= 0:
            violations.append(f"Invalid lead time: {lead_time} <= 0")
        if not (0.0 <= rel <= 1.0):
            violations.append(f"Invalid reliability score: {rel} outside [0.0, 1.0]")

        landed = calculate_landed_cost(c, order_units)

        # Operational guardrails
        if unit_cost > max_cost_ceiling:
            violations.append(
                f"Exceeds +50% cost ceiling (${unit_cost:.2f} > ${max_cost_ceiling:.2f})"
            )
        # Fix for Qodo #4: arrival strictly before stockout (lead_time < Days of Supply)
        if lead_time >= days_of_supply:
            violations.append(
                f"Exceeds stockout window ({lead_time}d >= {days_of_supply}d DoS)"
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

        # Base composite score: 40% cost, 30% lead time, 30% reliability
        base_score = (
            WEIGHT_COST * norm_cost
            + WEIGHT_LEAD_TIME * norm_lead
            + WEIGHT_RELIABILITY * norm_rel
        )

        # Disqualified suppliers receive heavy penalty
        if not e["eligible"]:
            composite_score = round(base_score * 0.15, 4)
        else:
            composite_score = round(base_score, 4)

        e["norm_cost"] = round(norm_cost, 4)
        e["norm_lead"] = round(norm_lead, 4)
        e["norm_rel"] = round(norm_rel, 4)
        e["composite_score"] = composite_score

    # 4. Rank candidates: eligible candidates first, sorted by composite_score desc
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

    # Fix for Qodo #6: Fail fast on invalid explicit --input
    if args.input:
        try:
            raw = args.input.strip()
            if raw.startswith("[") or raw.startswith("{"):
                loaded = json.loads(raw)
            else:
                with open(raw, "r", encoding="utf-8") as f:
                    loaded = json.load(f)

            if isinstance(loaded, list):
                candidates = loaded
            elif isinstance(loaded, dict) and "candidates" in loaded:
                candidates = loaded["candidates"]
                if "primary" in loaded and loaded["primary"] is not None:
                    primary = loaded["primary"]
            else:
                raise ValueError("Input JSON must be an array of suppliers or an object with 'candidates'")
        except Exception as err:
            sys.stderr.write(f"Error: Invalid --input payload: {err}\n")
            sys.exit(1)

    try:
        ranked = optimize_suppliers(candidates, primary, args.units)
    except Exception as err:
        sys.stderr.write(f"Error: Optimization failed: {err}\n")
        sys.exit(1)

    # Fix for Qodo #3: Return top recommendation only if eligible, else None
    eligible_picks = [r for r in ranked if r["eligible"]]
    top_pick = eligible_picks[0] if eligible_picks else None

    if args.json:
        payload = {
            "sku": args.sku,
            "order_units": args.units,
            "weights": {
                "cost": WEIGHT_COST,
                "lead_time": WEIGHT_LEAD_TIME,
                "reliability": WEIGHT_RELIABILITY,
            },
            "top_recommendation": (
                {
                    "supplier_name": top_pick["supplier_name"],
                    "supplier_id": top_pick["supplier_id"],
                    "landed_cost": top_pick["landed_cost"],
                    "lead_time_days": top_pick["lead_time_days"],
                    "reliability_score": top_pick["reliability_score"],
                    "composite_score": top_pick["composite_score"],
                    "eligible": True,
                }
                if top_pick
                else None
            ),
            "ranked_suppliers": ranked,
        }
        print(json.dumps(payload, indent=2))
    else:
        print("\n================================================================================")
        print(f"📊 MULTI-CRITERIA SUPPLIER OPTIMIZATION REPORT ({args.sku})")
        print(f"Weights: Landed Cost: {int(WEIGHT_COST*100)}% | Lead Time: {int(WEIGHT_LEAD_TIME*100)}% | Reliability: {int(WEIGHT_RELIABILITY*100)}%")
        print(f"Order Volume: {args.units} units | Stockout Horizon: {primary['days_of_supply']} days")
        print("================================================================================\n")
        print(render_markdown_table(ranked))
        print("\n🏆 Top Ranked Recommendation:")
        if top_pick:
            print(f"   Supplier: {top_pick['supplier_name']} (Rank #{top_pick['rank']})")
            print(f"   Landed Cost: ${top_pick['landed_cost']:.2f}/unit | Lead Time: {top_pick['lead_time_days']} days | Reliability: {top_pick['reliability_score']:.2f}")
            print(f"   Composite Score: {top_pick['composite_score']:.4f}")
        else:
            print("   ⚠️ No candidate supplier meets all operational guardrails and arrival windows.")
        print("================================================================================\n")


if __name__ == "__main__":
    main()
