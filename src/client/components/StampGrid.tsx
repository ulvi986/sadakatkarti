interface Props {
  stamps: number;
  needed: number;
  rewardReady: boolean;
  /** Bu indeksdən sonrakı möhürlər animasiya ilə görünür (yeni vurulanlar) */
  animateFrom?: number | null;
  /** Vurulmuş möhürdə şirkətin loqosu; yoxdursa adının baş hərfi */
  logoUrl?: string | null;
  companyName: string;
}

export default function StampGrid({ stamps, needed, rewardReady, animateFrom = null, logoUrl = null, companyName }: Props) {
  return (
    <div className="stamps">
      {Array.from({ length: needed }, (_, i) => {
        const on = i < stamps;
        const pop = on && animateFrom !== null && i >= animateFrom;
        return (
          <div key={i} className={`stamp${on ? ' on' : ''}${pop ? ' pop' : ''}`}>
            {on && (logoUrl ? <img className="stamp-logo" src={logoUrl} alt="" /> : companyName.trim().charAt(0).toUpperCase())}
          </div>
        );
      })}
      <div className={`stamp free${rewardReady ? ' ready' : ''}`}>PULSUZ</div>
    </div>
  );
}
