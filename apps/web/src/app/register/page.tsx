import Link from 'next/link';
import { AuthShell } from '@/components/auth-shell';
import { RegisterForm } from './register-form';

export const metadata = { title: 'Create account' };

export default function RegisterPage() {
  return (
    <AuthShell title="Create your account" footer={<>Already registered? <Link className="text-accent underline" href="/login">Sign in</Link></>}>
      <RegisterForm />
    </AuthShell>
  );
}
