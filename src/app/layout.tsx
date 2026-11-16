import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trellis sample",
  description: "A sample app showing Trellis patterns in a real repo.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
