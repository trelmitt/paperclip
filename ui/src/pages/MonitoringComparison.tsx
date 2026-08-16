import { useState, useMemo } from "react";

const MONITORING_PROVIDERS = [
{"vendor": "UptimeRobot", "tier_name": "Free", "monitors": 50, "check_interval": "5m", "status_page": true, "log_retention": "3 months", "price": "$0", "url": "https://uptimerobot.com", "stability": "stable"},
{"vendor": "360 Monitoring", "tier_name": "Lite", "monitors": 6, "check_interval": "10m", "status_page": false, "log_retention": "24 hours", "price": "$0", "url": "https://360monitoring.com", "stability": "stable"},
{"vendor": "SweetUptime", "tier_name": "Free", "monitors": 30, "check_interval": "Varies", "status_page": true, "log_retention": "Unlimited", "price": "$0", "url": "https://dicloud.net/sweetuptime", "stability": "stable"},
{"vendor": "Google Cloud Monitoring", "tier_name": "Always Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "30 days", "price": "$0", "url": "https://cloud.google.com/monitoring", "stability": "stable"},
{"vendor": "UptimeObserver.com", "tier_name": "Free", "monitors": 20, "check_interval": "5m", "status_page": true, "log_retention": "Unlimited", "price": "$0", "url": "https://uptimeobserver.com", "stability": "stable"},
{"vendor": "uptimetoolbox.com", "tier_name": "Free", "monitors": 5, "check_interval": "3m", "status_page": true, "log_retention": "Unlimited", "price": "$0", "url": "https://uptimetoolbox.com", "stability": "stable"},
{"vendor": "Pulsetic", "tier_name": "Free", "monitors": 10, "check_interval": "5m", "status_page": true, "log_retention": "3 months", "price": "$0", "url": "https://pulsetic.com", "stability": "stable"},
{"vendor": "StatusCake", "tier_name": "Free", "monitors": 10, "check_interval": "5m", "status_page": true, "log_retention": "Varies", "price": "$0", "url": "https://www.statuscake.com", "stability": "stable"},
{"vendor": "Cronitor", "tier_name": "Hacker", "monitors": 5, "check_interval": "5m", "status_page": true, "log_retention": "12 months", "price": "$0", "url": "https://cronitor.io", "stability": "stable"},
{"vendor": "Uptimia", "tier_name": "Free", "monitors": 1, "check_interval": "5m", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://www.uptimia.com", "stability": "stable"},
{"vendor": "OnlineOrNot", "tier_name": "Free", "monitors": 3, "check_interval": "3m", "status_page": true, "log_retention": "Varies", "price": "$0", "url": "https://onlineornot.com", "stability": "stable"},
{"vendor": "BetterStack", "tier_name": "Free", "monitors": 10, "check_interval": "Varies", "status_page": true, "log_retention": "3 GB / 3 days", "price": "$0", "url": "https://betterstack.com", "stability": "stable"},
{"vendor": "MonitorMonk", "tier_name": "Free", "monitors": 10, "check_interval": "Varies", "status_page": true, "log_retention": "Unlimited", "price": "$0", "url": "https://monitormonk.com", "stability": "stable"},
{"vendor": "phare.io", "tier_name": "Free", "monitors": "Unlimited", "check_interval": "Varies", "status_page": true, "log_retention": "Unlimited events", "price": "$0", "url": "https://phare.io", "stability": "stable"},
{"vendor": "pingbreak.com", "tier_name": "Free", "monitors": "Unlimited", "check_interval": "Varies", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://pingbreak.com", "stability": "stable"},
{"vendor": "syagent.com", "tier_name": "Free", "monitors": 25, "check_interval": "Varies", "status_page": false, "log_retention": "Metrics", "price": "$0", "url": "https://syagent.com", "stability": "stable"},
{"vendor": "Xitoring.com", "tier_name": "Free", "monitors": 20, "check_interval": "Varies", "status_page": true, "log_retention": "Varies", "price": "$0", "url": "https://xitoring.com", "stability": "stable"},
{"vendor": "bleemeo.com", "tier_name": "Free", "monitors": 5, "check_interval": "Varies", "status_page": false, "log_retention": "Unlimited", "price": "$0", "url": "https://bleemeo.com", "stability": "stable"},
{"vendor": "downtimemonkey.com", "tier_name": "Free", "monitors": 60, "check_interval": "5m", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://downtimemonkey.com", "stability": "stable"},
{"vendor": "Pingmeter.com", "tier_name": "Free", "monitors": 5, "check_interval": "10m", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://pingmeter.com", "stability": "stable"},
{"vendor": "Sentry", "tier_name": "Developer", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "5GB application logs", "price": "$0", "url": "https://sentry.io", "stability": "watch"},
{"vendor": "Datadog", "tier_name": "Free", "monitors": 5, "check_interval": "Varies", "status_page": false, "log_retention": "1 day", "price": "$0", "url": "https://www.datadoghq.com", "stability": "stable"},
{"vendor": "Grafana Cloud", "tier_name": "Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "50 GB", "price": "$0", "url": "https://grafana.com", "stability": "stable"},
{"vendor": "Axiom", "tier_name": "Personal", "monitors": 3, "check_interval": "Varies", "status_page": false, "log_retention": "500 GB / 30 days", "price": "$0", "url": "https://axiom.co", "stability": "stable"},
{"vendor": "New Relic", "tier_name": "Free", "monitors": 500, "check_interval": "Varies", "status_page": false, "log_retention": "100 GB", "price": "$0", "url": "https://newrelic.com", "stability": "stable"},
{"vendor": "Healthchecks.io", "tier_name": "Free", "monitors": 20, "check_interval": "Varies", "status_page": false, "log_retention": "100 entries per job", "price": "$0", "url": "https://healthchecks.io", "stability": "stable"},
{"vendor": "Prometheus", "tier_name": "Free OSS", "monitors": "Unlimited", "check_interval": "Varies", "status_page": false, "log_retention": "Retention based on storage", "price": "$0", "url": "https://prometheus.io", "stability": "stable"},
{"vendor": "Jaeger", "tier_name": "Free OSS", "monitors": "Unlimited", "check_interval": "Varies", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://www.jaegertracing.io", "stability": "stable"},
{"vendor": "PagerDuty", "tier_name": "Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://www.pagerduty.com", "stability": "stable"},
{"vendor": "Sematext", "tier_name": "Basic (Free)", "monitors": 3, "check_interval": "30m", "status_page": false, "log_retention": "500 MB/day / 7 days", "price": "$0", "url": "https://sematext.com", "stability": "stable"},
{"vendor": "AppSignal", "tier_name": "Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "1 GB / month", "price": "$0", "url": "https://www.appsignal.com", "stability": "stable"},
{"vendor": "Middleware.io", "tier_name": "Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "100 GB / month", "price": "$0", "url": "https://middleware.io", "stability": "stable"},
{"vendor": "StatusPile", "tier_name": "Free", "monitors": "Status pages only", "check_interval": "Varies", "status_page": true, "log_retention": "None", "price": "$0", "url": "https://www.statuspile.com", "stability": "stable"},
{"vendor": "assertible.com", "tier_name": "Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://assertible.com", "stability": "stable"},
{"vendor": "Core Web Vitals History", "tier_name": "Free", "monitors": "URL-based", "check_interval": "On-demand", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://punits.dev/core-web-vitals-historical", "stability": "stable"},
{"vendor": "deadmanssnitch.com", "tier_name": "Free", "monitors": 1, "check_interval": "Varies", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://deadmanssnitch.com", "stability": "stable"},
{"vendor": "economize.cloud", "tier_name": "Free", "monitors": "Cloud cost", "check_interval": "Daily", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://economize.cloud", "stability": "improving"},
{"vendor": "fivenines.io", "tier_name": "Free", "monitors": 5, "check_interval": "60s", "status_page": false, "log_retention": "Real-time", "price": "$0", "url": "https://fivenines.io", "stability": "stable"},
{"vendor": "incidenthub.cloud", "tier_name": "Free", "monitors": 5, "check_interval": "Varies", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://incidenthub.cloud", "stability": "watch"},
{"vendor": "inspector.dev", "tier_name": "Free", "monitors": "Real-time dashboard", "check_interval": "Real-time", "status_page": false, "log_retention": "Real-time", "price": "$0", "url": "https://www.inspector.dev", "stability": "stable"},
{"vendor": "linkok.com", "tier_name": "Free", "monitors": 100, "check_interval": "Varies", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://linkok.com", "stability": "stable"},
{"vendor": "loader.io", "tier_name": "Free", "monitors": "Load testing", "check_interval": "On-demand", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://loader.io", "stability": "stable"},
{"vendor": "netdata.cloud", "tier_name": "Free", "monitors": "Unlimited", "check_interval": "Real-time", "status_page": false, "log_retention": "Real-time", "price": "$0", "url": "https://www.netdata.cloud", "stability": "stable"},
{"vendor": "OntarioNet.ca CN Test", "tier_name": "Free", "monitors": "URL check", "check_interval": "On-demand", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://cntest.ontarionet.ca", "stability": "stable"},
{"vendor": "pagecrawl.io", "tier_name": "Free", "monitors": 6, "check_interval": "60m", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://pagecrawl.io", "stability": "stable"},
{"vendor": "pagertree.com", "tier_name": "Free", "monitors": "On-call", "check_interval": "Varies", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://pagertree.com", "stability": "stable"},
{"vendor": "Hyperping", "tier_name": "Free", "monitors": 20, "check_interval": "5m", "status_page": true, "log_retention": "Varies", "price": "$0", "url": "https://hyperping.com", "stability": "watch"},
{"vendor": "incident.io", "tier_name": "Basic", "monitors": "Incident management", "check_interval": "Varies", "status_page": true, "log_retention": "Varies", "price": "$0", "url": "https://incident.io", "stability": "stable"},
{"vendor": "Baseline", "tier_name": "Free OSS", "monitors": "Open source", "check_interval": "Varies", "status_page": false, "log_retention": "None", "price": "$0", "url": "https://baseline.dev", "stability": "stable"},
{"vendor": "Cachet", "tier_name": "Free OSS", "monitors": "Open source status page", "check_interval": "Varies", "status_page": true, "log_retention": "None", "price": "$0", "url": "https://cachethq.io", "stability": "stable"},
{"vendor": "Cron Alternatives", "tier_name": "Free", "monitors": "Varies", "check_interval": "Varies", "status_page": false, "log_retention": "Varies", "price": "$0", "url": "https://cronalternatives.com", "stability": "stable"},
];

type FilterState = {
  minMonitors: string;
  hasStatusPage: boolean;
  stability: string[];
  logRetention: string;
};

const STABILITY_OPTIONS = [
  { label: "Stable", value: "stable" },
  { label: "Watch", value: "watch" },
  { label: "Improving", value: "improving" },
];

const MONITORS_OPTIONS = [
  { label: "Any", value: "" },
  { label: "5 or more", value: "5" },
  { label: "10 or more", value: "10" },
  { label: "20 or more", value: "20" },
  { label: "50 or more", value: "50" },
  { label: "Unlimited", value: "Unlimited" },
];

const LOG_RETENTION_OPTIONS = [
  { label: "Any", value: "" },
  { label: "None", value: "None" },
  { label: "24 hours", value: "24 hours" },
  { label: "3 days", value: "3 days" },
  { label: "7 days", value: "7 days" },
  { label: "30 days", value: "30 days" },
  { label: "3 months", value: "3 months" },
  { label: "1 year", value: "12 months" },
  { label: "Unlimited", value: "Unlimited" },
];

export default function MonitoringComparisonPage() {
  const [filters, setFilters] = useState<FilterState>({
    minMonitors: "",
    hasStatusPage: false,
    stability: [],
    logRetention: "",
  });

  const filteredProviders = useMemo(() => {
    return MONITORING_PROVIDERS.filter((provider) => {
      if (filters.minMonitors) {
        const minMonitorsNum = parseInt(filters.minMonitors);
        const providerMonitors =
          typeof provider.monitors === "number"
            ? provider.monitors
            : provider.monitors === "Unlimited"
              ? Infinity
              : provider.monitors === "Varies"
                ? 100
                : parseInt(provider.monitors) || 0;
        if (providerMonitors < minMonitorsNum) return false;
      }

      if (filters.hasStatusPage && !provider.status_page) return false;

      if (filters.stability.length > 0 && !filters.stability.includes(provider.stability)) {
        return false;
      }

      if (filters.logRetention && provider.log_retention !== filters.logRetention) {
        return false;
      }

      return true;
    });
  }, [filters]);

  const handleChangeMinMonitors = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((prev) => ({ ...prev, minMonitors: e.target.value }));
  };

  const handleChangeStatusPage = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters((prev) => ({ ...prev, hasStatusPage: e.target.checked }));
  };

  const handleChangeStability = (value: string) => {
    setFilters((prev) => ({
      ...prev,
      stability: prev.stability.includes(value)
        ? prev.stability.filter((v) => v !== value)
        : [...prev.stability, value],
    }));
  };

  const handleChangeLogRetention = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((prev) => ({ ...prev, logRetention: e.target.value }));
  };

  const clearFilters = () => {
    setFilters({
      minMonitors: "",
      hasStatusPage: false,
      stability: [],
      logRetention: "",
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Monitoring Comparison</h1>
          <p className="mt-2 text-muted-foreground">
            Compare free tiers and monitoring services to find the right tool for your needs.
          </p>
        </div>

        <div className="mb-6 rounded-xl border bg-card p-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Minimum Monitors</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={filters.minMonitors}
                onChange={handleChangeMinMonitors}
              >
                {MONITORS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end space-y-2">
              <div className="flex h-10 items-center space-x-2">
                <input
                  id="status-page"
                  type="checkbox"
                  className="h-4 w-4 rounded border border-input bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  checked={filters.hasStatusPage}
                  onChange={handleChangeStatusPage}
                />
                <label htmlFor="status-page" className="text-sm font-medium leading-none">
                  Has Status Page
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Stability</label>
              <div className="flex flex-wrap gap-2">
                {STABILITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleChangeStability(opt.value)}
                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      filters.stability.includes(opt.value)
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Log Retention</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={filters.logRetention}
                onChange={handleChangeLogRetention}
              >
                {LOG_RETENTION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {(filters.minMonitors || filters.hasStatusPage || filters.stability.length > 0 || filters.logRetention) && (
            <div className="mt-4 pt-4 border-t">
              <button
                type="button"
                onClick={clearFilters}
                className="text-sm text-primary hover:underline"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>

        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {filteredProviders.length} of {MONITORING_PROVIDERS.length} providers
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProviders.map((provider) => (
            <div
              key={provider.vendor}
              className="flex flex-col rounded-xl border bg-card p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-foreground">{provider.vendor}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{provider.tier_name} tier</p>
                </div>
                {provider.stability === "stable" && (
                  <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-600">
                    Stable
                  </span>
                )}
                {provider.stability === "watch" && (
                  <span className="inline-flex items-center rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium text-yellow-600">
                    Watch
                  </span>
                )}
                {provider.stability === "improving" && (
                  <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600">
                    Improving
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Price</span>
                  <span className="font-medium text-foreground">{provider.price}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Monitors</span>
                  <span className="font-medium text-foreground">{provider.monitors}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Interval</span>
                  <span className="font-medium text-foreground">{provider.check_interval}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-muted-foreground">Retention</span>
                  <span className="font-medium text-foreground truncate" title={provider.log_retention}>
                    {provider.log_retention}
                  </span>
                </div>
              </div>

              {provider.status_page && (
                <div className="mb-3 inline-flex items-center rounded-md border px-2 py-1 text-xs text-muted-foreground">
                  + Status Page
                </div>
              )}

              <div className="mt-auto">
                <a
                  href={provider.url}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {provider.vendor} Website
                </a>
              </div>
            </div>
          ))}
        </div>

        {filteredProviders.length === 0 && (
          <div className="text-center py-12">
            <h3 className="text-lg font-semibold text-foreground">No providers found</h3>
            <p className="mt-2 text-muted-foreground">Try adjusting your filters to find what you're looking for.</p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
