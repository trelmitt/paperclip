import { ExternalLink } from "lucide-react";

interface AgentDealsReferralProps {
  vendor: string;
  className?: string;
}

export function AgentDealsReferral({ vendor, className = "" }: AgentDealsReferralProps) {
  const referralUrl = `https://agentdeals.com/referral/${encodeURIComponent(vendor)}`;
  
  return (
    <a
      href={referralUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline ${className}`}
      title="Get bonus credits via AgentDeals"
    >
      <ExternalLink className="h-3 w-3" />
      <span>AgentDeals Referral</span>
    </a>
  );
}
