// public: the root shell; renders no data
export const metadata = { title: 'Holdout' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
