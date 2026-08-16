import { ExternalLink } from "lucide-react";

interface AgentDealsReferralLinkProps {
  vendor: string;
  className?: string;
}

export default function AgentDealsReferralLink({ vendor, className = "" }: AgentDealsReferralLinkProps) {
  const referralUrl = `https://agentdeals.co/r/${encodeURIComponent(vendor)}`;

  return (
    <a
      href={referralUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors ${className}`}
    >
      <span className="mr-1">See on AgentDeals</span>
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}
