interface Props {
  stamps: number;
  needed: number;
  rewardReady: boolean;
  /** Bu indeksdən sonrakı möhürlər animasiya ilə görünür (yeni vurulanlar) */
  animateFrom?: number | null;
}

export default function StampGrid({ stamps, needed, rewardReady, animateFrom = null }: Props) {
  return (
    <div className="stamps">
      {Array.from({ length: needed }, (_, i) => {
        const on = i < stamps;
        const pop = on && animateFrom !== null && i >= animateFrom;
        return (
          <div key={i} className={`stamp${on ? ' on' : ''}${pop ? ' pop' : ''}`}>
            {on ? '☕' : ''}
          </div>
        );
      })}
      <div className={`stamp free${rewardReady ? ' ready' : ''}`}>PULSUZ</div>
    </div>
  );
}
