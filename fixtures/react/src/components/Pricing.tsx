const plans = [
  { name: "Starter", price: "$0", blurb: "For individuals exploring their data." },
  { name: "Team", price: "$24", blurb: "Shared dashboards for growing teams." },
  { name: "Scale", price: "$99", blurb: "Governance and SSO for larger orgs." },
];

export function Pricing() {
  return (
    <section className="pricing">
      <h2 className="pricing-title">Simple pricing</h2>
      <div className="plan-grid">
        {plans.map((p) => (
          <div className="plan" key={p.name}>
            <h3>{p.name}</h3>
            <p className="price">{p.price}</p>
            <p>{p.blurb}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
