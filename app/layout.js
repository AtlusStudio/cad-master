import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "CAD Master｜洁净室自动排板",
  description: "上传 CAD 图纸，识别墙体与门窗，再使用 AI 排版或智能排版。",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#eef1f4] font-sans text-[#17202b]">{children}</body>
    </html>
  );
}
