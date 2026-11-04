import { Component, inject } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';

@Component({
  imports: [ReactiveFormsModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './sales-order.html',
})
export class App {
  private readonly formBuilder = inject(FormBuilder);

  protected readonly itemRows = this.formBuilder.array<FormGroup>([this.createRow()]);
  protected readonly orderForm = this.formBuilder.group({
    customer: [''],
    date: [''],
    billTo: this.formBuilder.group({
      name: [''],
      companyName: [''],
      postalAddress: [''],
      phoneNo: [''],
      faxNo: [''],
      email: [''],
      ntn: [''],
    }),
    shipTo: this.formBuilder.group({
      name: [''],
      companyName: [''],
      postalAddress: [''],
      phoneNo: [''],
      faxNo: [''],
      email: [''],
      ntn: [''],
    }),
    deliveryDate: [''],
    dueDate: [''],
    paymentTerms: [''],
    incoterm: [''],
    items: this.itemRows,
    totalBalanceIncludingTax: [''],
  });

  protected createRow(): FormGroup {
    return this.formBuilder.group({
      quantity: [''],
      unit: [''],
      productName: [''],
      unitPrice: [''],
      total: [''],
    });
  }

  protected addRow(): void {
    this.itemRows.push(this.createRow());
  }

  protected removeRow(index: number): void {
    if (index > 0 && index < this.itemRows.length) {
      this.itemRows.removeAt(index);
    }
  }
}
