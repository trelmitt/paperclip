import { ExternalLink } from "lucide-react";

interface AgentDealsProps {
  vendor: string;
  className?: string;
}

export function AgentDeals({ vendor, className = "" }: AgentDealsProps) {
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
      <span>AgentDeals</span>
    </a>
  );
}
