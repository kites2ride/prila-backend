import { Types } from 'mongoose';
import { CommissionRule } from '../app/model.js';

type CommissionLean = {
  mode: 'percentage' | 'fixed' | 'subscription';
  value: number;
  version?: number;
};

export async function resolveCommission(input: {
  cityId: string;
  serviceType: string;
  grossPaise: number;
}): Promise<{
  mode: string;
  value: number;
  commissionPaise: number;
  version: number;
}> {
  const cityOid = new Types.ObjectId(input.cityId);
  const serviceType = input.serviceType as 'bike' | 'auto' | 'parcel' | 'logistics' | 'all';

  let rule = (await CommissionRule.findOne({
    cityId: cityOid,
    serviceType,
    enabled: true,
  }).lean()) as CommissionLean | null;

  if (!rule) {
    rule = (await CommissionRule.findOne({
      cityId: cityOid,
      serviceType: 'all',
      enabled: true,
    }).lean()) as CommissionLean | null;
  }

  if (!rule) {
    return { mode: 'percentage', value: 0, commissionPaise: 0, version: 0 };
  }

  let commissionPaise = 0;
  if (rule.mode === 'percentage') {
    commissionPaise = Math.round((input.grossPaise * rule.value) / 10_000);
  } else if (rule.mode === 'fixed') {
    commissionPaise = rule.value;
  } else if (rule.mode === 'subscription') {
    commissionPaise = 0;
  }

  commissionPaise = Math.min(commissionPaise, input.grossPaise);
  return {
    mode: rule.mode,
    value: rule.value,
    commissionPaise,
    version: rule.version ?? 1,
  };
}
