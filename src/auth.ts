import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

const gmailScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      authorization: {
        params: {
          scope: gmailScopes,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  // JWT sessions so middleware can run on the Edge; Account rows still store refresh tokens.
  session: { strategy: "jwt" },
  trustHost: true,
  callbacks: {
    async jwt({ token, user, account }) {
      if (user?.id) {
        token.sub = user.id;
      }
      // Persist linking side-effects are handled by the adapter; keep token minimal.
      if (account?.provider === "google" && user?.id) {
        token.sub = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
});
